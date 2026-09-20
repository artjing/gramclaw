import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import extract from "extract-zip";
import {
  addCollection,
  defaultAccount,
  ensureAccount,
  getDb,
  rebuildFts,
  recordFollowSnapshot,
  transaction,
  upsertComment,
  upsertMedia,
  upsertPost,
  upsertProfile,
} from "./db.js";
import { ensureDirs } from "./config.js";
import {
  createRunId,
  decodeInstagramText,
  inferUsernameFromUrl,
  json,
  normalizeUsername,
  nowIso,
  shortcodeFromUrl,
  stableId,
  timestampToIso,
} from "./utils.js";

export const ARCHIVE_SLICES = [
  "posts",
  "stories",
  "comments",
  "likes",
  "saved",
  "directMessages",
  "followers",
  "following",
  "profiles",
];

export function findArchives() {
  const roots = [join(homedir(), "Downloads"), join(homedir(), "Desktop")];
  const candidates = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const path of walk(root, { maxDepth: 2, filter: (name) => /\.zip$/i.test(name) })) {
      const name = basename(path).toLowerCase();
      if (!name.includes("instagram") && !name.includes("meta") && !name.includes("information")) continue;
      const stat = statSync(path);
      const format = probeArchiveFormat(path);
      candidates.push({
        path,
        name: basename(path),
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        format,
        importable: format === "json" || format === "html",
      });
    }
  }
  return candidates.sort((a, b) => {
    if (a.importable !== b.importable) return a.importable ? -1 : 1;
    return b.modifiedAt.localeCompare(a.modifiedAt);
  });
}

function probeArchiveFormat(archivePath) {
  try {
    const listing = execFileSync("unzip", ["-Z1", archivePath], {
      encoding: "utf8",
      maxBuffer: 4_000_000,
      timeout: 8_000,
    });
    const names = listing.split(/\r?\n/).filter(Boolean);
    let jsonCount = 0;
    let htmlCount = 0;
    for (const name of names) {
      if (/\.json$/i.test(name)) jsonCount += 1;
      else if (/\.html$/i.test(name)) htmlCount += 1;
      if (jsonCount > 0 && htmlCount > 0) break;
    }
    if (jsonCount > 0) return "json";
    if (htmlCount > 0) return "html";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export async function importArchive(archivePath, options = {}) {
  const sourcePath = resolve(archivePath);
  if (!existsSync(sourcePath)) throw new Error(`Archive not found: ${sourcePath}`);
  const runId = createRunId("import");
  const db = getDb();
  db.prepare(`
    insert into import_runs(id, source_path, status, counts_json, started_at)
    values (?, ?, 'running', '{}', ?)
  `).run(runId, sourcePath, nowIso());
  let cleanup;
  try {
    const resolved = await resolveArchive(sourcePath);
    cleanup = resolved.cleanup;
    const analysis = analyzeArchive(resolved.rootDir, options);
    assertImportableArchive(resolved.rootDir, analysis);
    const selected = normalizeSelected(options.select);
    const counts = applyArchive(db, analysis, {
      selected,
      restore: Boolean(options.restore),
      rootDir: resolved.rootDir,
      sourcePath,
    });
    const report = buildImportReport(analysis, resolved.rootDir, selected, counts);
    const imported = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
    if (imported === 0) {
      throw new Error(
        "No Instagram posts, messages, or relationships were found in this archive. Request a new download from Accounts Center and choose JSON format.",
      );
    }
    db.prepare(`
      update import_runs set status='succeeded', counts_json=?, completed_at=? where id=?
    `).run(json(counts, {}), nowIso(), runId);
    return {
      ok: true,
      runId,
      sourcePath,
      account: defaultAccount(db),
      selected,
      restore: Boolean(options.restore),
      counts,
      report,
      filesScanned: analysis.filesScanned,
      warnings: analysis.warnings,
    };
  } catch (error) {
    db.prepare(`
      update import_runs set status='failed', error=?, completed_at=? where id=?
    `).run(error instanceof Error ? error.message : String(error), nowIso(), runId);
    throw error;
  } finally {
    cleanup?.();
  }
}

function buildImportReport(analysis, rootDir, selected, counts) {
  const media = [
    ...analysis.posts.flatMap((post) => post.media ?? []),
    ...analysis.stories.flatMap((post) => post.media ?? []),
    ...analysis.threads.flatMap((thread) =>
      (thread.messages ?? []).flatMap((message) => message.media ?? [])),
  ];
  const mediaFilesAvailable = media.filter((item) => archiveMediaExists(item.uri, rootDir)).length;
  const mediaFilesMissing = media.length - mediaFilesAvailable;
  const recordKeys = ["posts", "stories", "comments", "likes", "saved", "directMessages", "followers", "following"];
  const recordsImported = recordKeys.reduce((sum, key) => sum + Number(counts[key] || 0), 0);
  return {
    format: analysis.format,
    filesScanned: analysis.filesScanned,
    recordsImported,
    mediaReferences: media.length,
    mediaFilesAvailable,
    mediaFilesMissing,
    metadataOnly: {
      saved: selected.includes("saved") ? analysis.saved.length : 0,
      likes: selected.includes("likes") ? analysis.likes.length : 0,
    },
    warnings: [...analysis.warnings],
  };
}

function archiveMediaExists(uri, rootDir) {
  if (!uri) return false;
  const source = resolve(rootDir, String(uri).replace(/^\/+/, ""));
  return source.startsWith(resolve(rootDir) + sep) && existsSync(source) && statSync(source).isFile();
}

function normalizeSelected(select) {
  if (!select || select.length === 0) return [...ARCHIVE_SLICES];
  const aliases = {
    dms: "directMessages",
    "direct-messages": "directMessages",
    directmessages: "directMessages",
    bookmarks: "saved",
    saves: "saved",
  };
  const normalized = [];
  for (const raw of Array.isArray(select) ? select : String(select).split(",")) {
    const key = String(raw).trim();
    const canonical = aliases[key.toLowerCase()] ?? key;
    if (!ARCHIVE_SLICES.includes(canonical)) {
      throw new Error(`Unknown archive slice "${key}". Choose from: ${ARCHIVE_SLICES.join(", ")}`);
    }
    if (!normalized.includes(canonical)) normalized.push(canonical);
  }
  return normalized;
}

async function resolveArchive(path) {
  const stat = statSync(path);
  if (stat.isDirectory()) return { rootDir: path, cleanup: null };
  if (extname(path).toLowerCase() !== ".zip") {
    throw new Error("Instagram export must be a ZIP file or extracted directory.");
  }
  const tempDir = mkdtempSync(join(tmpdir(), "gramclaw-import-"));
  await extract(path, { dir: tempDir });
  const entries = readdirSync(tempDir, { withFileTypes: true });
  const rootDir = entries.length === 1 && entries[0].isDirectory()
    ? join(tempDir, entries[0].name)
    : tempDir;
  return {
    rootDir,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

function analyzeArchive(rootDir) {
  const jsonAnalysis = analyzeJsonArchive(rootDir);
  if (jsonAnalysis.filesScanned > 0) return jsonAnalysis;
  return analyzeHtmlArchive(rootDir);
}

function analyzeJsonArchive(rootDir) {
  const jsonFiles = walk(rootDir, { filter: (name) => /\.json$/i.test(name) });
  const analysis = {
    filesScanned: jsonFiles.length,
    format: "json",
    profile: null,
    posts: [],
    stories: [],
    comments: [],
    likes: [],
    saved: [],
    threads: [],
    followers: [],
    following: [],
    warnings: [],
  };
  for (const path of jsonFiles) {
    const rel = relative(rootDir, path).split(sep).join("/").toLowerCase();
    let data;
    try {
      data = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      analysis.warnings.push(`Skipped unreadable JSON: ${relative(rootDir, path)}`);
      continue;
    }
    if (isMessageFile(rel, data)) {
      analysis.threads.push(parseThread(data, rel));
      continue;
    }
    if (isFollowersFile(rel, data)) {
      analysis.followers.push(...parseRelationshipData(data));
      continue;
    }
    if (isFollowingFile(rel, data)) {
      analysis.following.push(...parseRelationshipData(data));
      continue;
    }
    const likedRows = findArrayByKeys(data, ["likes_media_likes", "liked_posts", "likes"]);
    if (rel.includes("liked_posts") || likedRows.some(isRelationshipStyleMedia)) {
      analysis.likes.push(...likedRows.map((row) => parseCollectionRow(row, "liked")).filter(Boolean));
      continue;
    }
    const savedRows = findArrayByKeys(data, ["saved_saved_media", "saved_posts", "bookmarks"]);
    if (rel.includes("saved_posts") || rel.includes("/saved/") || savedRows.some(isRelationshipStyleMedia)) {
      analysis.saved.push(...savedRows.map((row) => parseCollectionRow(row, "saved")).filter(Boolean));
      continue;
    }
    const commentRows = findArrayByKeys(data, ["comments_media_comments", "post_comments", "comments"]);
    if (rel.includes("post_comments") || rel.includes("/comments/")) {
      analysis.comments.push(...commentRows.map(parseCommentRow).filter(Boolean));
      continue;
    }
    if (isStoryFile(rel)) {
      analysis.stories.push(...parsePostContainer(data, "story", rel));
      continue;
    }
    if (isPostFile(rel, data)) {
      const kind = rel.includes("archived") ? "archived" : "post";
      analysis.posts.push(...parsePostContainer(data, kind, rel));
      continue;
    }
    if (isProfileFile(rel)) {
      analysis.profile = mergeProfile(analysis.profile, parseProfileData(data));
    }
  }
  analysis.followers = dedupeRelationship(analysis.followers);
  analysis.following = dedupeRelationship(analysis.following);
  return analysis;
}

function analyzeHtmlArchive(rootDir) {
  const htmlFiles = walk(rootDir, { filter: (name) => /\.html$/i.test(name) });
  const analysis = {
    filesScanned: htmlFiles.length,
    format: "html",
    profile: null,
    posts: [],
    stories: [],
    comments: [],
    likes: [],
    saved: [],
    threads: [],
    followers: [],
    following: [],
    warnings: [],
  };
  let ownerUsername = null;
  for (const path of htmlFiles) {
    const rel = relative(rootDir, path).split(sep).join("/").toLowerCase();
    let html;
    try {
      html = readFileSync(path, "utf8");
    } catch {
      analysis.warnings.push(`Skipped unreadable HTML: ${relative(rootDir, path)}`);
      continue;
    }
    ownerUsername ??= extractGeneratedUsername(html);
    if (rel.includes("followers_and_following/followers") || /\/followers_\d+\.html$/.test(rel)) {
      analysis.followers.push(...parseHtmlRelationships(html));
      continue;
    }
    if (rel.includes("followers_and_following/following") || rel.endsWith("/following.html")) {
      analysis.following.push(...parseHtmlRelationships(html));
      continue;
    }
    if (rel.includes("/likes/liked_posts") || rel.endsWith("liked_posts.html")) {
      analysis.likes.push(...parseHtmlCollectionItems(html, "liked"));
      continue;
    }
    if (rel.includes("/saved/saved_posts") || rel.endsWith("saved_posts.html")) {
      analysis.saved.push(...parseHtmlCollectionItems(html, "saved"));
      continue;
    }
    if (rel.includes("/comments/post_comments") || rel.includes("/comments/")) {
      analysis.comments.push(...parseHtmlComments(html));
      continue;
    }
    if (rel.includes("/messages/inbox/") || rel.includes("/messages/message_requests/")) {
      if (/message_\d+\.html$/.test(rel)) {
        analysis.threads.push(parseHtmlThread(html, rel, ownerUsername));
      }
      continue;
    }
    if (rel.includes("/media/stories") || rel.endsWith("/stories.html")) {
      analysis.stories.push(...parseHtmlPosts(html, "story", rel, ownerUsername));
      continue;
    }
    if (rel.includes("/media/reels") || rel.endsWith("/reels.html")) {
      analysis.posts.push(...parseHtmlPosts(html, "reel", rel, ownerUsername));
      continue;
    }
    if (rel.includes("/media/posts") || /\/posts(?:_\d+)?\.html$/.test(rel)) {
      analysis.posts.push(...parseHtmlPosts(html, "post", rel, ownerUsername));
      continue;
    }
    if (rel.includes("personal_information") || rel.includes("instagram_profile_information")) {
      analysis.profile = mergeProfile(analysis.profile, parseHtmlProfile(html, ownerUsername));
    }
  }
  if (!analysis.profile && ownerUsername) {
    analysis.profile = {
      username: ownerUsername,
      displayName: ownerUsername,
      biography: "",
      avatarUrl: null,
      website: null,
      externalUserId: null,
      raw: { source: "html-generated-by" },
    };
  }
  analysis.followers = dedupeRelationship(analysis.followers);
  analysis.following = dedupeRelationship(analysis.following);
  analysis.posts = dedupeBy(analysis.posts, (post) => post.id);
  analysis.stories = dedupeBy(analysis.stories, (post) => post.id);
  analysis.threads = analysis.threads.filter((thread) => thread.messages.length > 0);
  return analysis;
}

function assertImportableArchive(_rootDir, analysis) {
  const total =
    analysis.posts.length
    + analysis.stories.length
    + analysis.comments.length
    + analysis.likes.length
    + analysis.saved.length
    + analysis.threads.length
    + analysis.followers.length
    + analysis.following.length
    + (analysis.profile?.username ? 1 : 0);
  if (total > 0) return;
  if (analysis.format === "html" && analysis.filesScanned > 0) {
    throw new Error(
      "This HTML Instagram export was readable, but no posts, messages, or relationships were recognized.",
    );
  }
  throw new Error(
    "No Instagram JSON or HTML export data was found in that archive.",
  );
}

function extractGeneratedUsername(html) {
  const match = String(html).match(/Generated by\s+([^<\s]+)/i);
  return normalizeUsername(match?.[1] ?? "") || null;
}

function htmlContentBlocks(html) {
  return [...String(html).matchAll(
    /<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder">([\s\S]*?)(?=<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder">|<\/main>)/g,
  )].map((match) => match[1]);
}

function stripHtml(value) {
  return decodeInstagramText(decodeHtmlEntities(
    String(value ?? "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ));
}

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#0?39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)));
}

function parseHtmlDate(value) {
  return timestampToIso(stripHtml(value));
}

function parseHtmlRelationships(html) {
  const rows = [];
  for (const block of htmlContentBlocks(html)) {
    const link = block.match(/href="(https?:\/\/(?:www\.)?instagram\.com\/[^"]+)"/i);
    const heading = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const username = normalizeUsername(
      heading ? stripHtml(heading[1]) : inferUsernameFromUrl(link?.[1]) || stripHtml(link?.[1] ?? ""),
    );
    if (!username) continue;
    const dateMatch = block.match(/<div>([A-Z][a-z]{2} \d{1,2}, \d{4}[^<]*)<\/div>/)
      || block.match(/<div class="_3-94[^"]*">([^<]+)<\/div>/);
    rows.push({
      username,
      displayName: username,
      href: link?.[1] ?? null,
      timestamp: parseHtmlDate(dateMatch?.[1]) ?? nowIso(),
      raw: { source: "html", username },
    });
  }
  return rows;
}

function parseHtmlPosts(html, kind, sourcePath, ownerUsername) {
  const posts = [];
  for (const block of htmlContentBlocks(html)) {
    const captionMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const caption = captionMatch ? stripHtml(captionMatch[1]) : "";
    const mediaUris = [...new Set(
      [...block.matchAll(/(?:src|href)="((?:media|files)\/[^"]+)"/gi)].map((match) => match[1]),
    )].filter((uri) => !/instagram-logo/i.test(uri));
    const dateMatch = block.match(/<div class="_3-94[^"]*">([^<]+)<\/div>/);
    const createdAt = parseHtmlDate(dateMatch?.[1]);
    if (!mediaUris.length && !caption) continue;
    const media = mediaUris.map((uri) => ({
      uri,
      remoteUrl: null,
      createdAt,
      width: null,
      height: null,
      durationMs: null,
      altText: "",
      raw: { uri, source: "html" },
    }));
    posts.push({
      id: stableId("post", kind, createdAt, caption, mediaUris[0], sourcePath),
      shortcode: null,
      kind,
      caption,
      createdAt,
      permalink: null,
      authorUsername: ownerUsername || "",
      authorDisplayName: ownerUsername || "",
      media,
      raw: { source: "html", sourcePath, caption },
    });
  }
  return posts;
}

function parseHtmlCollectionItems(html, kind) {
  const items = [];
  for (const block of htmlContentBlocks(html)) {
    const link = block.match(/href="(https?:\/\/(?:www\.)?instagram\.com\/[^"]+)"/i);
    const href = link?.[1] ?? null;
    if (!href) continue;
    const owner = block.match(/>Owner<\/h2>[\s\S]*?<a[^>]*href="[^"]*"[^>]*>([^<]+)</i)
      || block.match(/Media Owner[\s\S]*?<div>([^<]+)<\/div>/i);
    const dateMatch = block.match(/<div class="_3-94[^"]*">([^<]+)<\/div>/)
      || block.match(/<td class="_2piu _a6_r">([^<]+)<\/td>/);
    const username = normalizeUsername(owner?.[1] || inferUsernameFromUrl(href) || "unknown");
    items.push({
      kind,
      href,
      username,
      timestamp: parseHtmlDate(dateMatch?.[1]),
      raw: { source: "html", href, username },
    });
  }
  return items;
}

function parseHtmlComments(html) {
  const comments = [];
  for (const block of htmlContentBlocks(html)) {
    const textMatch = block.match(/>Comment<\/(?:td|h2)>[\s\S]*?<div>([^<]+)<\/div>/i)
      || block.match(/<td[^>]*>Comment<\/td>[\s\S]*?<div>([^<]+)<\/div>/i);
    const text = stripHtml(textMatch?.[1] ?? "");
    if (!text) continue;
    const ownerMatch = block.match(/Media Owner[\s\S]*?<div>([^<]+)<\/div>/i);
    const timeMatch = block.match(/>Time<\/td>\s*<td[^>]*>([^<]+)<\/td>/i);
    comments.push({
      text,
      createdAt: parseHtmlDate(timeMatch?.[1]),
      authorUsername: "",
      postId: null,
      mediaOwner: stripHtml(ownerMatch?.[1] ?? "") || null,
      raw: { source: "html", text },
    });
  }
  return comments;
}

function parseHtmlThread(html, sourcePath, ownerUsername) {
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = stripHtml(titleMatch?.[1] ?? basename(dirname(sourcePath))) || "Conversation";
  const participants = new Map();
  const messages = [];
  for (const [index, block] of htmlContentBlocks(html).entries()) {
    const senderMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const senderName = stripHtml(senderMatch?.[1] ?? "") || "Unknown";
    const bodyMatch = block.match(/<div class="_3-95 _a6-p">([\s\S]*?)<\/div>\s*<div class="_3-94/);
    let text = "";
    if (bodyMatch) {
      const nested = [...bodyMatch[1].matchAll(/<div>([\s\S]*?)<\/div>/g)]
        .map((match) => stripHtml(match[1]))
        .filter(Boolean);
      text = nested.join("\n");
    }
    const media = [...new Set(
      [...block.matchAll(/(?:src|href)="((?:media|files|\.\.\/)[^"]+\.(?:jpg|jpeg|png|gif|mp4|webp))"/gi)]
        .map((match) => match[1].replace(/^\.\.\//, "")),
    )].map((uri) => ({
      uri,
      remoteUrl: null,
      createdAt: null,
      width: null,
      height: null,
      durationMs: null,
      altText: "",
      raw: { uri, source: "html-dm" },
    }));
    const dateMatch = block.match(/<div class="_3-94[^"]*">([^<]+)<\/div>/);
    const createdAt = parseHtmlDate(dateMatch?.[1]);
    if (!text && !media.length) continue;
    participants.set(senderName, {
      displayName: senderName,
      username: normalizeUsername(senderName) || stableId("dm_user", senderName),
    });
    messages.push({
      id: stableId("dm", sourcePath, createdAt, senderName, text, index),
      externalMessageId: null,
      senderName,
      text,
      createdAt,
      media,
      reactions: [],
      share: {},
      raw: { source: "html", senderName, text },
    });
  }
  messages.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  const last = messages.at(-1);
  if (ownerUsername && !participants.has(ownerUsername)) {
    participants.set(ownerUsername, {
      displayName: ownerUsername,
      username: ownerUsername,
    });
  }
  return {
    id: stableId("thread", sourcePath, title),
    title,
    threadPath: sourcePath,
    participants: [...participants.values()],
    messages,
    lastMessageAt: last?.createdAt ?? null,
    needsReply: Boolean(last && ownerUsername && !samePerson(last.senderName, ownerUsername)),
    raw: { source: "html", sourcePath },
  };
}

function parseHtmlProfile(html, ownerUsername) {
  const username = extractGeneratedUsername(html) || ownerUsername || null;
  const bioMatch = html.match(/>Biography<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i)
    || html.match(/>Bio<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
  const nameMatch = html.match(/>Name<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
  return {
    username: normalizeUsername(username || stripHtml(nameMatch?.[1] ?? "")) || null,
    displayName: stripHtml(nameMatch?.[1] ?? "") || username || null,
    biography: stripHtml(bioMatch?.[1] ?? ""),
    avatarUrl: null,
    website: null,
    externalUserId: null,
    raw: { source: "html-profile" },
  };
}

function applyArchive(db, analysis, context) {
  const selected = new Set(context.selected);
  const accountInput = analysis.profile ?? inferAccountFromAnalysis(analysis);
  const account = ensureAccount(db, {
    username: accountInput.username || defaultAccount(db)?.username || "instagram_user",
    displayName: accountInput.displayName || accountInput.username || "Instagram user",
    externalUserId: accountInput.externalUserId,
    biography: accountInput.biography,
    avatarUrl: accountInput.avatarUrl,
    transport: "archive",
    isDefault: true,
  });
  const counts = Object.fromEntries(ARCHIVE_SLICES.map((slice) => [slice, 0]));
  const paths = ensureDirs();
  transaction(db, () => {
    if (context.restore) restoreSelected(db, account.id, selected);
    if (selected.has("profiles") && analysis.profile) {
      upsertProfile(db, {
        externalUserId: analysis.profile.externalUserId,
        username: analysis.profile.username || account.username,
        displayName: analysis.profile.displayName,
        biography: analysis.profile.biography,
        avatarUrl: analysis.profile.avatarUrl,
        website: analysis.profile.website,
        source: "archive",
        raw: analysis.profile.raw,
      });
      counts.profiles += 1;
    }
    if (selected.has("posts")) {
      for (const post of analysis.posts) {
        importPost(db, post, account, context.rootDir, paths, counts);
        counts.posts += 1;
      }
    }
    if (selected.has("stories")) {
      for (const post of analysis.stories) {
        importPost(db, post, account, context.rootDir, paths, counts);
        counts.stories += 1;
      }
    }
    if (selected.has("likes")) {
      for (const item of analysis.likes) {
        const post = ensureCollectionPost(db, item, account);
        addCollection(db, {
          accountId: account.id,
          postId: post.id,
          kind: "liked",
          collectedAt: item.timestamp,
          source: "archive",
          raw: item.raw,
        });
        counts.likes += 1;
      }
    }
    if (selected.has("saved")) {
      for (const item of analysis.saved) {
        const post = ensureCollectionPost(db, item, account);
        addCollection(db, {
          accountId: account.id,
          postId: post.id,
          kind: "saved",
          collectedAt: item.timestamp,
          source: "archive",
          raw: item.raw,
        });
        counts.saved += 1;
      }
    }
    if (selected.has("comments")) {
      for (const comment of analysis.comments) {
        upsertComment(db, {
          ...comment,
          isOwn: true,
          source: "archive",
        });
        counts.comments += 1;
      }
    }
    if (selected.has("directMessages")) {
      for (const thread of analysis.threads) {
        counts.directMessages += importThread(db, thread, account, context.rootDir, paths);
      }
    }
    if (selected.has("followers") && analysis.followers.length) {
      const profileIds = importRelationships(db, analysis.followers, counts);
      recordFollowSnapshot(db, {
        accountId: account.id,
        direction: "followers",
        profileIds,
        source: "archive",
        complete: context.restore,
      });
      counts.followers = profileIds.length;
    }
    if (selected.has("following") && analysis.following.length) {
      const profileIds = importRelationships(db, analysis.following, counts);
      recordFollowSnapshot(db, {
        accountId: account.id,
        direction: "following",
        profileIds,
        source: "archive",
        complete: context.restore,
      });
      counts.following = profileIds.length;
    }
  });
  rebuildFts(db);
  return counts;
}

function restoreSelected(db, accountId, selected) {
  if (selected.has("posts")) db.prepare("delete from posts where account_id=? and kind in ('post','carousel','reel','archived') and source='archive'").run(accountId);
  if (selected.has("stories")) db.prepare("delete from posts where account_id=? and kind='story' and source='archive'").run(accountId);
  if (selected.has("comments")) db.exec("delete from comments where source='archive'");
  if (selected.has("likes")) db.prepare("delete from collections where account_id=? and kind='liked' and source='archive'").run(accountId);
  if (selected.has("saved")) db.prepare("delete from collections where account_id=? and kind='saved' and source='archive'").run(accountId);
  if (selected.has("directMessages")) {
    db.prepare("delete from dm_messages where thread_id in (select id from dm_threads where account_id=? and source='archive')").run(accountId);
    db.prepare("delete from dm_participants where thread_id in (select id from dm_threads where account_id=? and source='archive')").run(accountId);
    db.prepare("delete from dm_threads where account_id=? and source='archive'").run(accountId);
  }
}

function importPost(db, input, account, rootDir, paths, counts) {
  const profile = upsertProfile(db, {
    username: input.authorUsername || account.username,
    displayName: input.authorDisplayName || input.authorUsername || account.display_name,
    source: "archive",
  });
  counts.profiles += 1;
  const kind = input.media.length > 1 && input.kind === "post" ? "carousel" : input.kind;
  const post = upsertPost(db, {
    id: input.id,
    shortcode: input.shortcode,
    accountId: account.id,
    authorProfileId: profile.id,
    kind,
    caption: input.caption,
    createdAt: input.createdAt,
    permalink: input.permalink,
    isOwn: profile.username === account.username,
    source: "archive",
    raw: input.raw,
  });
  input.media.forEach((media, index) => {
    const localPath = copyArchiveMedia(media.uri, rootDir, paths.mediaOriginalsDir, post.id);
    upsertMedia(db, {
      postId: post.id,
      index,
      mediaType: inferMediaType(media.uri, media),
      localPath,
      remoteUrl: media.remoteUrl,
      width: media.width,
      height: media.height,
      durationMs: media.durationMs,
      altText: media.altText,
      createdAt: media.createdAt ?? input.createdAt,
      source: "archive",
      raw: media.raw,
    });
  });
  return post;
}

function ensureCollectionPost(db, item, account) {
  const username = item.username || inferUsernameFromUrl(item.href) || "unknown";
  const profile = upsertProfile(db, { username, displayName: username, source: "archive" });
  const shortcode = shortcodeFromUrl(item.href);
  return upsertPost(db, {
    id: stableId("post", shortcode || item.href || username, item.timestamp),
    shortcode: shortcode || null,
    accountId: account.id,
    authorProfileId: profile.id,
    kind: "placeholder",
    caption: "",
    createdAt: item.timestamp,
    permalink: item.href,
    source: "archive",
    raw: item.raw,
  });
}

function importThread(db, thread, account, rootDir, paths) {
  const threadId = thread.id;
  const now = nowIso();
  db.prepare(`
    insert into dm_threads(
      id, account_id, title, thread_path, last_message_at, unread_count,
      needs_reply, source, raw_json, updated_at
    ) values (?, ?, ?, ?, ?, 0, ?, 'archive', ?, ?)
    on conflict(id) do update set
      title=excluded.title,
      last_message_at=max(coalesce(dm_threads.last_message_at,''), coalesce(excluded.last_message_at,'')),
      raw_json=excluded.raw_json,
      updated_at=excluded.updated_at
  `).run(
    threadId,
    account.id,
    thread.title || "Conversation",
    thread.threadPath,
    thread.lastMessageAt,
    thread.needsReply ? 1 : 0,
    json(thread.raw, {}),
    now,
  );
  const participants = new Map();
  for (const participant of thread.participants) {
    const profile = upsertProfile(db, {
      username: participant.username,
      displayName: participant.displayName,
      source: "archive",
    });
    participants.set(participant.displayName, profile);
    db.prepare("insert or ignore into dm_participants(thread_id, profile_id) values (?, ?)").run(threadId, profile.id);
  }
  let count = 0;
  for (const message of thread.messages) {
    const isOwn = samePerson(message.senderName, account.username) || samePerson(message.senderName, account.display_name);
    const sender = isOwn
      ? upsertProfile(db, { username: account.username, displayName: account.display_name, source: "archive" })
      : participants.get(message.senderName)
        ?? upsertProfile(db, {
          username: normalizeUsername(message.senderName) || stableId("dm_user", message.senderName),
          displayName: message.senderName,
          source: "archive",
        });
    db.prepare(`
      insert into dm_messages(
        id, external_message_id, thread_id, sender_profile_id, text, created_at,
        direction, media_json, reactions_json, share_json, source, raw_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'archive', ?)
      on conflict(id) do update set
        text=excluded.text,
        media_json=excluded.media_json,
        reactions_json=excluded.reactions_json,
        share_json=excluded.share_json,
        raw_json=excluded.raw_json
    `).run(
      message.id,
      message.externalMessageId,
      threadId,
      sender.id,
      message.text,
      message.createdAt,
      message.direction ?? (isOwn ? "outbound" : "inbound"),
      json(message.media, []),
      json(message.reactions, []),
      json(message.share, {}),
      json(message.raw, {}),
    );
    for (const [index, media] of message.media.entries()) {
      const localPath = copyArchiveMedia(media.uri, rootDir, paths.mediaOriginalsDir, message.id);
      upsertMedia(db, {
        id: stableId("dm_media", message.id, index, media.uri),
        dmMessageId: message.id,
        index,
        mediaType: inferMediaType(media.uri, media),
        localPath,
        remoteUrl: media.remoteUrl,
        source: "archive",
        raw: media.raw,
      });
    }
    count += 1;
  }
  return count;
}

function importRelationships(db, relationships, counts) {
  return relationships.map((item) => {
    const profile = upsertProfile(db, {
      username: item.username,
      displayName: item.displayName || item.username,
      source: "archive",
      observedAt: item.timestamp,
      raw: item.raw,
    });
    counts.profiles += 1;
    return profile.id;
  });
}

function parsePostContainer(data, kind, sourcePath) {
  const arrays = Array.isArray(data)
    ? [data]
    : collectArrays(data).filter((array) => array.some((item) => item && typeof item === "object" && ("media" in item || "uri" in item || "creation_timestamp" in item)));
  const rows = arrays.flat();
  const posts = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const media = Array.isArray(row.media)
      ? row.media.map(parseMediaRow).filter(Boolean)
      : row.uri
        ? [parseMediaRow(row)].filter(Boolean)
        : [];
    if (!media.length && !row.title && !row.caption) continue;
    const createdAt = timestampToIso(row.creation_timestamp ?? media[0]?.createdAt ?? row.timestamp);
    const caption = decodeInstagramText(row.title ?? row.caption ?? row.description ?? "");
    const href = row.href ?? row.permalink ?? row.media?.[0]?.href ?? null;
    const shortcode = shortcodeFromUrl(href);
    posts.push({
      id: stableId("post", shortcode || href || createdAt, caption, media[0]?.uri, sourcePath),
      shortcode: shortcode || null,
      kind: kind === "post" && /reel|video/i.test(sourcePath) ? "reel" : kind,
      caption,
      createdAt,
      permalink: href,
      authorUsername: normalizeUsername(row.username ?? row.owner ?? ""),
      authorDisplayName: row.owner ?? row.username ?? "",
      media,
      raw: row,
    });
  }
  return dedupeBy(posts, (post) => post.id);
}

function parseMediaRow(row) {
  if (!row || typeof row !== "object") return null;
  const uri = row.uri ?? row.path ?? row.media_uri ?? null;
  const exif = row.media_metadata?.photo_metadata?.exif_data?.[0] ?? row.media_metadata?.video_metadata?.exif_data?.[0] ?? {};
  return {
    uri,
    remoteUrl: row.url ?? row.remote_url ?? null,
    createdAt: timestampToIso(row.creation_timestamp ?? row.timestamp),
    width: row.width ?? exif.image_width ?? null,
    height: row.height ?? exif.image_height ?? null,
    durationMs: row.duration_ms ?? null,
    altText: decodeInstagramText(row.alt_text ?? row.title ?? ""),
    raw: row,
  };
}

function parseCollectionRow(row, kind) {
  if (!row || typeof row !== "object") return null;
  const list = Array.isArray(row.string_list_data) ? row.string_list_data : [];
  const map = row.string_map_data && typeof row.string_map_data === "object"
    ? Object.values(row.string_map_data)
    : [];
  const item = [...list, ...map].find((entry) => entry && (entry.href || entry.timestamp || entry.value)) ?? {};
  const href = item.href ?? row.href ?? null;
  const username = normalizeUsername(row.title ?? row.username ?? inferUsernameFromUrl(href));
  if (!href && !username) return null;
  return {
    kind,
    href,
    username,
    timestamp: timestampToIso(item.timestamp ?? row.timestamp),
    raw: row,
  };
}

function parseCommentRow(row) {
  if (!row || typeof row !== "object") return null;
  const values = row.string_map_data ?? row.string_list_data?.[0] ?? {};
  const commentValue = values.Comment ?? values.comment ?? values;
  const ownerValue = values["Media Owner"] ?? values.media_owner ?? {};
  const text = decodeInstagramText(commentValue.value ?? row.text ?? row.comment ?? "");
  if (!text) return null;
  return {
    text,
    createdAt: timestampToIso(commentValue.timestamp ?? row.timestamp),
    authorUsername: normalizeUsername(row.username ?? ""),
    postId: row.post_id ?? null,
    raw: row,
    mediaOwner: ownerValue.value ?? null,
  };
}

function parseThread(data, sourcePath) {
  const title = decodeInstagramText(data.title ?? basename(dirname(sourcePath)));
  const participants = (Array.isArray(data.participants) ? data.participants : []).map((participant) => {
    const displayName = decodeInstagramText(participant.name ?? participant.username ?? "Unknown");
    return {
      displayName,
      username: normalizeUsername(participant.username ?? displayName) || stableId("dm_user", displayName),
    };
  });
  const messages = (Array.isArray(data.messages) ? data.messages : []).map((message, index) => {
    const createdAt = timestampToIso(message.timestamp_ms ?? message.timestamp);
    const senderName = decodeInstagramText(message.sender_name ?? message.sender ?? "Unknown");
    const media = [
      ...(message.photos ?? []),
      ...(message.videos ?? []),
      ...(message.audio_files ?? []),
      ...(message.gifs ?? []),
      ...(message.files ?? []),
    ].map(parseMediaRow).filter(Boolean);
    const text = decodeInstagramText(
      message.content
        ?? message.share?.share_text
        ?? message.share?.link
        ?? message.call_duration
        ?? message.type
        ?? "",
    );
    return {
      id: message.message_id ?? stableId("dm", data.thread_path ?? title, createdAt, senderName, text, index),
      externalMessageId: message.message_id ?? null,
      senderName,
      text,
      createdAt,
      media,
      reactions: message.reactions ?? [],
      share: message.share ?? {},
      raw: message,
    };
  }).sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  const last = messages.at(-1);
  return {
    id: stableId("thread", data.thread_path ?? title, participants.map((item) => item.displayName).sort().join("|")),
    title,
    threadPath: data.thread_path ?? sourcePath,
    participants,
    messages,
    lastMessageAt: last?.createdAt ?? null,
    needsReply: last ? !participants.some((participant) => samePerson(participant.displayName, last.senderName)) : false,
    raw: data,
  };
}

function parseRelationshipData(data) {
  const arrays = Array.isArray(data) ? [data] : collectArrays(data);
  const rows = arrays.flat();
  return rows.map((row) => {
    if (!row || typeof row !== "object") return null;
    const item = Array.isArray(row.string_list_data) ? row.string_list_data[0] ?? {} : row;
    const username = normalizeUsername(item.value ?? row.username ?? row.title ?? inferUsernameFromUrl(item.href));
    if (!username) return null;
    return {
      username,
      displayName: decodeInstagramText(row.title || item.value || username),
      href: item.href ?? null,
      timestamp: timestampToIso(item.timestamp ?? row.timestamp) ?? nowIso(),
      raw: row,
    };
  }).filter(Boolean);
}

function parseProfileData(data) {
  const candidates = collectObjects(data);
  const candidate = candidates.find((item) =>
    item.username || item.user_name || item.biography || item.profile_photo
  ) ?? {};
  const stringMap = candidate.string_map_data ?? data.profile_user?.[0]?.string_map_data ?? {};
  const username = normalizeUsername(
    candidate.username
      ?? candidate.user_name
      ?? stringMap.Username?.value
      ?? stringMap.username?.value
      ?? "",
  );
  return {
    username,
    displayName: decodeInstagramText(
      candidate.name ?? candidate.display_name ?? stringMap.Name?.value ?? username,
    ),
    biography: decodeInstagramText(
      candidate.biography ?? candidate.bio ?? stringMap.Bio?.value ?? "",
    ),
    website: candidate.website ?? candidate.external_url ?? stringMap.Website?.href ?? null,
    avatarUrl: candidate.profile_photo ?? candidate.profile_pic_url ?? null,
    externalUserId: candidate.id ? String(candidate.id) : null,
    raw: data,
  };
}

function inferAccountFromAnalysis(analysis) {
  const ownPost = [...analysis.posts, ...analysis.stories].find((post) => post.authorUsername);
  return {
    username: ownPost?.authorUsername ?? "instagram_user",
    displayName: ownPost?.authorDisplayName ?? ownPost?.authorUsername ?? "Instagram user",
    biography: "",
  };
}

function copyArchiveMedia(uri, rootDir, mediaRoot, ownerId) {
  if (!uri) return null;
  const normalized = String(uri).replace(/^\/+/, "");
  const source = resolve(rootDir, normalized);
  if (!source.startsWith(resolve(rootDir) + sep) || !existsSync(source) || !statSync(source).isFile()) return null;
  const folder = join(mediaRoot, "archive", ownerId);
  const target = join(folder, basename(source));
  ensureDirectory(folder);
  if (!existsSync(target) || statSync(target).size !== statSync(source).size) copyFileSync(source, target);
  return target;
}

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o755 });
}

function walk(root, options = {}, depth = 0) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (options.maxDepth === undefined || depth < options.maxDepth) {
        results.push(...walk(path, options, depth + 1));
      }
    } else if (!options.filter || options.filter(entry.name, path)) {
      results.push(path);
    }
  }
  return results;
}

function findArrayByKeys(data, keys) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const key of keys) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
}

function collectArrays(value, found = [], depth = 0) {
  if (depth > 5 || value === null || value === undefined) return found;
  if (Array.isArray(value)) {
    found.push(value);
    for (const item of value.slice(0, 20)) collectArrays(item, found, depth + 1);
  } else if (typeof value === "object") {
    for (const item of Object.values(value).slice(0, 100)) collectArrays(item, found, depth + 1);
  }
  return found;
}

function collectObjects(value, found = [], depth = 0) {
  if (depth > 5 || value === null || value === undefined) return found;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) collectObjects(item, found, depth + 1);
  } else if (typeof value === "object") {
    found.push(value);
    for (const item of Object.values(value).slice(0, 100)) collectObjects(item, found, depth + 1);
  }
  return found;
}

function isMessageFile(path, data) {
  return path.includes("messages/") && path.includes("/inbox/") && Array.isArray(data?.messages);
}

function isFollowersFile(path, data) {
  return /followers(?:_\d+)?\.json$/.test(path) && Array.isArray(data);
}

function isFollowingFile(path, data) {
  return /following(?:_\d+)?\.json$/.test(path) || Array.isArray(data?.relationships_following);
}

function isStoryFile(path) {
  return /stories(?:_\d+)?\.json$/.test(path) || path.includes("stories_archive");
}

function isPostFile(path, data) {
  if (path.includes("liked_posts") || path.includes("saved_posts") || path.includes("post_comments")) return false;
  return /(?:^|\/)(?:posts|archived_posts|reels)(?:_\d+)?\.json$/.test(path)
    || (Array.isArray(data) && data.some((row) => row && Array.isArray(row.media)));
}

function isProfileFile(path) {
  return path.includes("personal_information") || /(?:profile|account_information)\.json$/.test(path);
}

function isRelationshipStyleMedia(row) {
  return row && typeof row === "object" && (Array.isArray(row.string_list_data) || row.string_map_data);
}

function inferMediaType(uri, row = {}) {
  const type = String(row.media_type ?? row.type ?? "").toLowerCase();
  if (type.includes("video") || /\.(mp4|mov|m4v|webm)$/i.test(String(uri ?? ""))) return "video";
  if (type.includes("audio") || /\.(mp3|m4a|wav|aac)$/i.test(String(uri ?? ""))) return "audio";
  if (type.includes("gif") || /\.gif$/i.test(String(uri ?? ""))) return "gif";
  return "image";
}

function samePerson(a, b) {
  return normalizeUsername(a).replace(/[._-]/g, "") === normalizeUsername(b).replace(/[._-]/g, "");
}

function dedupeRelationship(rows) {
  return dedupeBy(rows, (row) => row.username);
}

function dedupeBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (key && !map.has(key)) map.set(key, row);
  }
  return [...map.values()];
}

function mergeProfile(current, next) {
  if (!current) return next;
  return {
    ...current,
    ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== null && value !== "")),
    raw: { previous: current.raw, next: next.raw },
  };
}
