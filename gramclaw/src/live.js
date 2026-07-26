import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { getCookies, toCookieHeader } from "@steipete/sweet-cookie";
import { imageSize } from "image-size";
import {
  addCollection,
  defaultAccount,
  ensureAccount,
  getDb,
  rebuildFts,
  recordFollowSnapshot,
  upsertComment,
  upsertMedia,
  upsertPost,
  upsertProfile,
} from "./db.js";
import { graphListComments, graphListMedia, graphStatus, graphWhoAmI } from "./graph.js";
import {
  createRunId,
  json,
  normalizeUsername,
  nowIso,
  stableId,
  timestampToIso,
} from "./utils.js";

const WEB_BASE = "https://www.instagram.com";
const WEB_APP_ID = "936619743392459";

export async function authStatus(options = {}) {
  let cookie;
  try {
    const credentials = await resolveCredentials(options);
    cookie = {
      available: Boolean(credentials.sessionId && credentials.csrfToken),
      userId: credentials.userId || null,
      source: credentials.source,
      warnings: credentials.warnings,
      missing: [
        !credentials.sessionId ? "sessionid" : null,
        !credentials.csrfToken ? "csrftoken" : null,
      ].filter(Boolean),
    };
  } catch (error) {
    cookie = {
      available: false,
      source: "none",
      warnings: [error instanceof Error ? error.message : String(error)],
      missing: ["sessionid", "csrftoken"],
    };
  }
  return { cookie, graph: graphStatus(options) };
}

export async function resolveCredentials(options = {}) {
  const explicit = {
    sessionid: options.sessionId ?? process.env.GRAMCLAW_SESSIONID,
    csrftoken: options.csrfToken ?? process.env.GRAMCLAW_CSRFTOKEN,
    ds_user_id: options.userId ?? process.env.GRAMCLAW_DS_USER_ID,
  };
  if (explicit.sessionid && explicit.csrftoken) {
    const cookieHeader = Object.entries(explicit)
      .filter(([, value]) => value)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    return {
      sessionId: explicit.sessionid,
      csrfToken: explicit.csrftoken,
      userId: explicit.ds_user_id ?? "",
      cookieHeader,
      source: "env-or-flags",
      warnings: [],
    };
  }
  const browsers = normalizeBrowserSources(options.cookieSource);
  const result = await getCookies({
    url: `${WEB_BASE}/`,
    names: ["sessionid", "csrftoken", "ds_user_id", "mid", "ig_did", "rur", "datr", "dpr"],
    ...(browsers.length ? { browsers } : {}),
    ...(options.chromeProfile ? { chromeProfile: options.chromeProfile } : {}),
    ...(options.firefoxProfile ? { firefoxProfile: options.firefoxProfile } : {}),
    ...(options.cookieFile ? { inlineCookiesFile: options.cookieFile } : {}),
    timeoutMs: Number(options.cookieTimeout ?? 30_000),
    mode: "first",
  });
  const cookieMap = new Map(result.cookies.map((cookie) => [cookie.name, cookie.value]));
  const sessionId = explicit.sessionid ?? cookieMap.get("sessionid") ?? "";
  const csrfToken = explicit.csrftoken ?? cookieMap.get("csrftoken") ?? "";
  const userId = explicit.ds_user_id ?? cookieMap.get("ds_user_id") ?? "";
  const cookies = result.cookies.filter((cookie) => {
    if (cookie.name === "sessionid" && explicit.sessionid) return false;
    if (cookie.name === "csrftoken" && explicit.csrftoken) return false;
    if (cookie.name === "ds_user_id" && explicit.ds_user_id) return false;
    return true;
  });
  if (explicit.sessionid) cookies.push({ name: "sessionid", value: explicit.sessionid });
  if (explicit.csrftoken) cookies.push({ name: "csrftoken", value: explicit.csrftoken });
  if (explicit.ds_user_id) cookies.push({ name: "ds_user_id", value: explicit.ds_user_id });
  return {
    sessionId,
    csrfToken,
    userId,
    cookieHeader: toCookieHeader(cookies, { dedupeByName: true, sort: "none" }),
    source: cookies[0]?.source?.browser ?? (options.cookieFile ? "cookie-file" : "browser"),
    warnings: result.warnings,
  };
}

function normalizeBrowserSources(value) {
  const input = Array.isArray(value) ? value : value ? String(value).split(",") : [];
  return input
    .map((item) => String(item).trim().toLowerCase())
    .filter((item) => ["chrome", "edge", "firefox", "safari"].includes(item));
}

async function webRequest(path, options = {}) {
  const credentials = options.credentials ?? await resolveCredentials(options);
  if (!credentials.sessionId || !credentials.csrfToken) {
    throw new Error("Instagram web session not found. Sign in in a supported browser or set GRAMCLAW_SESSIONID and GRAMCLAW_CSRFTOKEN.");
  }
  const url = new URL(path.startsWith("http") ? path : `${WEB_BASE}${path.startsWith("/") ? "" : "/"}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  let body = options.body;
  const headers = {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    cookie: credentials.cookieHeader,
    referer: options.referer ?? `${WEB_BASE}/`,
    "user-agent": options.userAgent ?? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36",
    "x-asbd-id": "129477",
    "x-csrftoken": credentials.csrfToken,
    "x-ig-app-id": options.appId ?? WEB_APP_ID,
    "x-requested-with": "XMLHttpRequest",
    ...(options.headers ?? {}),
  };
  if (options.form) {
    body = new URLSearchParams();
    for (const [key, value] of Object.entries(options.form)) {
      if (value !== undefined && value !== null) {
        body.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      }
    }
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const response = await fetch(url, {
    method: options.method ?? (body ? "POST" : "GET"),
    headers,
    body,
    signal: AbortSignal.timeout(Number(options.timeout ?? 30_000)),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!response.ok || payload.status === "fail") {
    const reason = payload.message ?? payload.error_title ?? payload.raw ?? `HTTP ${response.status}`;
    const error = new Error(`Instagram web API: ${reason}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function webWhoAmI(options = {}) {
  const credentials = options.credentials ?? await resolveCredentials(options);
  const candidates = [
    "/api/v1/accounts/edit/web_form_data/",
    "/accounts/edit/?__a=1&__d=dis",
  ];
  let lastError;
  for (const path of candidates) {
    try {
      const payload = await webRequest(path, { ...options, credentials });
      const data = payload.form_data ?? payload.data ?? payload.user ?? payload;
      return {
        id: String(data.id ?? credentials.userId ?? ""),
        username: data.username ?? "",
        displayName: data.first_name ?? data.full_name ?? data.name ?? data.username ?? "",
        biography: data.biography ?? "",
        avatarUrl: data.profile_pic_url ?? data.profile_pic_url_hd ?? null,
        raw: payload,
        credentialSource: credentials.source,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function syncLive(stream, options = {}) {
  const mode = String(options.mode ?? "auto").toLowerCase();
  if (mode === "graph" || (mode === "auto" && graphStatus(options).available && ["profile", "posts", "comments"].includes(stream))) {
    return syncGraph(stream, options);
  }
  return syncWeb(stream, options);
}

async function syncGraph(stream, options = {}) {
  const db = getDb();
  const runId = createRunId("sync");
  const startedAt = nowIso();
  const existingAccount = defaultAccount(db);
  db.prepare(`
    insert into sync_runs(id, account_id, stream, transport, status, started_at)
    values (?, ?, ?, 'graph', 'running', ?)
  `).run(runId, existingAccount?.id ?? null, stream, startedAt);
  try {
    const me = await graphWhoAmI(options);
    const account = ensureAccount(db, {
      externalUserId: String(me.id),
      username: me.username,
      displayName: me.name ?? me.username,
      biography: me.biography ?? "",
      avatarUrl: me.profile_picture_url,
      transport: "graph",
    });
    const profile = upsertProfile(db, {
      externalUserId: String(me.id),
      username: me.username,
      displayName: me.name ?? me.username,
      biography: me.biography ?? "",
      avatarUrl: me.profile_picture_url,
      website: me.website,
      followersCount: me.followers_count,
      followingCount: me.follows_count,
      mediaCount: me.media_count,
      source: "graph",
      raw: me,
    });
    let counts = { profiles: 1 };
    if (stream === "posts" || stream === "comments") {
      const result = await graphListMedia(options);
      counts.posts = 0;
      counts.comments = 0;
      for (const item of result.items) {
        const post = normalizeGraphPost(item, account, profile);
        mergeNormalizedPost(db, post);
        counts.posts += 1;
        if (stream === "comments") {
          const comments = await graphListComments(item.id, options);
          for (const comment of comments.data ?? []) {
            mergeGraphComment(db, comment, post.id);
            counts.comments += 1;
            for (const reply of comment.replies?.data ?? []) {
              mergeGraphComment(db, reply, post.id, comment.id);
              counts.comments += 1;
            }
          }
        }
      }
    }
    rebuildFts(db);
    completeSync(db, runId, counts);
    return { ok: true, runId, stream, transport: "graph", counts, account };
  } catch (error) {
    failSync(db, runId, error);
    throw error;
  }
}

async function syncWeb(stream, options = {}) {
  const db = getDb();
  const runId = createRunId("sync");
  const startedAt = nowIso();
  const existingAccount = defaultAccount(db);
  db.prepare(`
    insert into sync_runs(id, account_id, stream, transport, status, started_at)
    values (?, ?, ?, 'cookie', 'running', ?)
  `).run(runId, existingAccount?.id ?? null, stream, startedAt);
  try {
    const credentials = await resolveCredentials(options);
    const me = await webWhoAmI({ ...options, credentials });
    const account = ensureAccount(db, {
      externalUserId: me.id || credentials.userId,
      username: me.username || existingAccount?.username || `user_${credentials.userId}`,
      displayName: me.displayName,
      biography: me.biography,
      avatarUrl: me.avatarUrl,
      transport: "cookie",
    });
    let counts = { profiles: 1 };
    if (stream === "profile") {
      const payload = await webRequest("/api/v1/users/web_profile_info/", {
        ...options,
        credentials,
        query: { username: options.username ?? account.username },
        referer: `${WEB_BASE}/${options.username ?? account.username}/`,
      });
      const user = payload.data?.user ?? payload.user ?? payload;
      upsertProfile(db, normalizeWebProfile(user));
      counts.profiles += 1;
    } else if (["posts", "timeline", "saved", "liked"].includes(stream)) {
      const items = await fetchWebFeed(stream, account, { ...options, credentials });
      counts.posts = 0;
      counts.media = 0;
      for (const item of items) {
        const post = normalizeWebPost(item, account);
        mergeNormalizedPost(db, post);
        counts.posts += 1;
        counts.media += post.media.length;
        if (stream === "saved" || stream === "liked") {
          addCollection(db, {
            accountId: account.id,
            postId: post.id,
            kind: stream === "saved" ? "saved" : "liked",
            collectedAt: nowIso(),
            source: "cookie",
            raw: item,
          });
          counts[stream] = (counts[stream] ?? 0) + 1;
        }
      }
    } else if (stream === "followers" || stream === "following") {
      const relation = await fetchRelationships(stream, account, { ...options, credentials });
      const ids = relation.items.map((user) => upsertProfile(db, normalizeWebProfile(user)).id);
      recordFollowSnapshot(db, {
        accountId: account.id,
        direction: stream,
        profileIds: ids,
        source: "cookie",
        complete: relation.complete,
      });
      counts[stream] = ids.length;
      counts.profiles += ids.length;
    } else if (stream === "dms") {
      const result = await fetchDms(account, { ...options, credentials });
      counts = { ...counts, ...result };
    } else if (stream === "comments") {
      const posts = db.prepare(`
        select id, external_media_id from posts
        where account_id=? and is_own=1 and external_media_id is not null
        order by created_at desc limit ?
      `).all(account.id, Number(options.limit ?? 30));
      counts.comments = 0;
      for (const post of posts) {
        const payload = await webRequest(`/api/v1/media/${post.external_media_id}/comments/`, {
          ...options,
          credentials,
          query: { can_support_threading: true, permalink_enabled: false },
        });
        for (const comment of payload.comments ?? []) {
          mergeWebComment(db, comment, post.id, account);
          counts.comments += 1;
          for (const child of comment.child_comments ?? []) {
            mergeWebComment(db, child, post.id, account, String(comment.pk ?? comment.id));
            counts.comments += 1;
          }
        }
      }
    } else {
      throw new Error(`Unsupported live sync stream: ${stream}`);
    }
    rebuildFts(db);
    completeSync(db, runId, counts);
    return {
      ok: true,
      runId,
      stream,
      transport: "cookie",
      credentialSource: credentials.source,
      warnings: credentials.warnings,
      counts,
      account,
    };
  } catch (error) {
    failSync(db, runId, error);
    throw error;
  }
}

async function fetchWebFeed(stream, account, options) {
  const endpoint = stream === "timeline"
    ? "/api/v1/feed/timeline/"
    : stream === "saved"
      ? "/api/v1/feed/saved/posts/"
      : stream === "liked"
        ? "/api/v1/feed/liked/"
        : `/api/v1/feed/user/${account.external_user_id ?? options.credentials.userId}/`;
  const limit = Number(options.limit ?? 100);
  const maxPages = Number(options.maxPages ?? 5);
  const items = [];
  let maxId = options.cursor ?? null;
  for (let page = 0; page < maxPages && items.length < limit; page += 1) {
    const payload = await webRequest(endpoint, {
      ...options,
      query: {
        count: Math.min(50, limit - items.length),
        ...(maxId ? { max_id: maxId } : {}),
      },
    });
    const pageItems = payload.items ?? payload.feed_items?.map((item) => item.media_or_ad).filter(Boolean) ?? [];
    items.push(...pageItems);
    maxId = payload.next_max_id ?? payload.next_max_id?.toString() ?? null;
    if (!payload.more_available || !maxId || pageItems.length === 0) break;
  }
  return items.slice(0, limit);
}

async function fetchRelationships(direction, account, options) {
  const userId = account.external_user_id ?? options.credentials.userId;
  if (!userId) throw new Error("Instagram user ID is required to sync relationships.");
  const endpoint = `/api/v1/friendships/${userId}/${direction}/`;
  const limit = Number(options.limit ?? 500);
  const maxPages = Number(options.maxPages ?? 20);
  const items = [];
  let maxId = options.cursor ?? null;
  let complete = false;
  for (let page = 0; page < maxPages && items.length < limit; page += 1) {
    const payload = await webRequest(endpoint, {
      ...options,
      query: {
        count: Math.min(200, limit - items.length),
        search_surface: "follow_list_page",
        ...(maxId ? { max_id: maxId } : {}),
      },
    });
    items.push(...(payload.users ?? []));
    maxId = payload.next_max_id ?? null;
    if (!payload.big_list || !maxId || (payload.users ?? []).length === 0) {
      complete = true;
      break;
    }
  }
  return { items, complete };
}

async function fetchDms(account, options) {
  const payload = await webRequest("/api/v1/direct_v2/inbox/", {
    ...options,
    query: {
      persistentBadging: true,
      folder: "",
      limit: Number(options.limit ?? 20),
      thread_message_limit: Number(options.messageLimit ?? 50),
    },
  });
  const threads = payload.inbox?.threads ?? payload.threads ?? [];
  let messages = 0;
  for (const thread of threads) {
    const threadId = String(thread.thread_id ?? thread.thread_v2_id ?? stableId("thread", thread.thread_title));
    const users = thread.users ?? [];
    const participants = users.map((user) => upsertProfile(getDb(), normalizeWebProfile(user)));
    const items = thread.items ?? [];
    const lastAt = timestampToIso(items[0]?.timestamp ? Number(items[0].timestamp) / 1000 : null);
    getDb().prepare(`
      insert into dm_threads(
        id, account_id, title, thread_path, last_message_at, unread_count,
        needs_reply, source, raw_json, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, 'cookie', ?, ?)
      on conflict(id) do update set
        title=excluded.title, last_message_at=excluded.last_message_at,
        unread_count=excluded.unread_count, needs_reply=excluded.needs_reply,
        raw_json=excluded.raw_json, updated_at=excluded.updated_at
    `).run(
      threadId,
      account.id,
      thread.thread_title ?? (participants.map((profile) => profile.display_name).join(", ") || "Conversation"),
      threadId,
      lastAt,
      Number(thread.read_state ?? 0) === 0 ? 1 : 0,
      items[0] && String(items[0].user_id ?? "") !== String(account.external_user_id) ? 1 : 0,
      json(thread, {}),
      nowIso(),
    );
    for (const profile of participants) {
      getDb().prepare("insert or ignore into dm_participants(thread_id, profile_id) values (?, ?)").run(threadId, profile.id);
    }
    for (const item of items) {
      const sender = users.find((user) => String(user.pk ?? user.id) === String(item.user_id));
      const senderProfile = sender ? upsertProfile(getDb(), normalizeWebProfile(sender)) : null;
      const id = String(item.item_id ?? stableId("dm", threadId, item.timestamp, item.text, item.user_id));
      getDb().prepare(`
        insert into dm_messages(
          id, external_message_id, thread_id, sender_profile_id, text, created_at,
          direction, media_json, reactions_json, share_json, source, raw_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cookie', ?)
        on conflict(id) do update set
          text=excluded.text, media_json=excluded.media_json,
          reactions_json=excluded.reactions_json, share_json=excluded.share_json,
          raw_json=excluded.raw_json
      `).run(
        id,
        item.item_id ?? null,
        threadId,
        senderProfile?.id ?? null,
        directItemText(item),
        timestampToIso(item.timestamp ? Number(item.timestamp) / 1000 : null),
        String(item.user_id ?? "") === String(account.external_user_id) ? "outbound" : "inbound",
        json(directItemMedia(item), []),
        json(item.reactions ?? [], []),
        json(item.link ?? item.media_share ?? item.reel_share ?? {}, {}),
        json(item, {}),
      );
      messages += 1;
    }
  }
  return { dmThreads: threads.length, dmMessages: messages };
}

function directItemText(item) {
  return item.text
    ?? item.link?.text
    ?? item.reel_share?.text
    ?? item.media_share?.caption?.text
    ?? item.voice_media?.audio?.audio_src
    ?? `[${item.item_type ?? "message"}]`;
}

function directItemMedia(item) {
  const media = item.media ?? item.visual_media?.media ?? item.media_share ?? item.reel_share?.media;
  if (!media) return [];
  const normalized = normalizeWebMedia(media);
  return normalized.media;
}

function normalizeWebProfile(user = {}) {
  return {
    externalUserId: String(user.pk ?? user.id ?? user.pk_id ?? ""),
    username: normalizeUsername(user.username ?? user.user_name ?? user.full_name ?? ""),
    displayName: user.full_name ?? user.name ?? user.username ?? "",
    biography: user.biography ?? user.bio ?? "",
    avatarUrl: user.profile_pic_url_hd ?? user.profile_pic_url ?? null,
    website: user.external_url ?? null,
    followersCount: user.follower_count ?? user.edge_followed_by?.count ?? 0,
    followingCount: user.following_count ?? user.edge_follow?.count ?? 0,
    mediaCount: user.media_count ?? user.edge_owner_to_timeline_media?.count ?? 0,
    isVerified: Boolean(user.is_verified),
    isPrivate: Boolean(user.is_private),
    source: "cookie",
    raw: user,
  };
}

function normalizeWebPost(item, account) {
  const user = item.user ?? item.owner ?? {};
  const author = normalizeWebProfile(user);
  const shortcode = item.code ?? item.shortcode ?? "";
  const mediaInfo = normalizeWebMedia(item);
  const productType = String(item.product_type ?? "").toLowerCase();
  const kind = item.media_type === 8
    ? "carousel"
    : productType.includes("clips") || productType.includes("reel")
      ? "reel"
      : item.media_type === 2
        ? "reel"
        : "post";
  return {
    id: stableId("post", item.pk ?? item.id ?? shortcode),
    externalMediaId: String(item.pk ?? item.id ?? ""),
    shortcode: shortcode || null,
    accountId: account.id,
    author,
    kind,
    caption: item.caption?.text ?? item.caption ?? "",
    altText: item.accessibility_caption ?? "",
    createdAt: timestampToIso(item.taken_at ?? item.device_timestamp),
    permalink: shortcode ? `${WEB_BASE}/${kind === "reel" ? "reel" : "p"}/${shortcode}/` : null,
    likeCount: item.like_count ?? 0,
    commentCount: item.comment_count ?? 0,
    viewCount: item.view_count ?? 0,
    playCount: item.play_count ?? 0,
    isOwn: String(user.pk ?? user.id ?? "") === String(account.external_user_id),
    location: item.location,
    media: mediaInfo.media,
    source: "cookie",
    raw: item,
  };
}

function normalizeWebMedia(item) {
  const children = item.carousel_media?.length ? item.carousel_media : [item];
  return {
    media: children.map((child, index) => {
      const image = child.image_versions2?.candidates?.[0]
        ?? child.carousel_media?.[0]?.image_versions2?.candidates?.[0]
        ?? {};
      const video = child.video_versions?.[0] ?? {};
      return {
        id: stableId("media", child.pk ?? child.id ?? item.pk, index),
        mediaType: child.media_type === 2 || video.url ? "video" : "image",
        remoteUrl: video.url ?? image.url ?? child.display_url ?? child.thumbnail_src ?? null,
        thumbnailUrl: image.url ?? child.thumbnail_url ?? null,
        width: video.width ?? image.width ?? child.original_width ?? null,
        height: video.height ?? image.height ?? child.original_height ?? null,
        durationMs: child.video_duration ? Math.round(Number(child.video_duration) * 1000) : null,
        altText: child.accessibility_caption ?? "",
        createdAt: timestampToIso(child.taken_at),
        source: "cookie",
        raw: child,
      };
    }),
  };
}

function normalizeGraphPost(item, account, profile) {
  const children = item.children?.data ?? [];
  const media = (children.length ? children : [item]).map((child, index) => ({
    id: stableId("media", child.id ?? item.id, index),
    mediaType: child.media_type === "VIDEO" || child.media_type === "REELS" ? "video" : "image",
    remoteUrl: child.media_url ?? child.thumbnail_url ?? null,
    thumbnailUrl: child.thumbnail_url ?? null,
    source: "graph",
    raw: child,
  }));
  const kind = item.media_type === "CAROUSEL_ALBUM"
    ? "carousel"
    : item.media_product_type === "REELS" || item.media_type === "VIDEO"
      ? "reel"
      : "post";
  return {
    id: stableId("post", item.id),
    externalMediaId: String(item.id),
    accountId: account.id,
    author: profile,
    kind,
    caption: item.caption ?? "",
    createdAt: timestampToIso(item.timestamp),
    permalink: item.permalink,
    likeCount: item.like_count ?? 0,
    commentCount: item.comments_count ?? 0,
    isOwn: true,
    media,
    source: "graph",
    raw: item,
  };
}

function mergeNormalizedPost(db, input) {
  const profile = input.author?.id
    ? input.author
    : upsertProfile(db, input.author ?? { username: "unknown", source: input.source });
  const post = upsertPost(db, {
    ...input,
    authorProfileId: profile.id,
  });
  for (const media of input.media ?? []) {
    upsertMedia(db, { ...media, postId: post.id });
  }
  return post;
}

function mergeWebComment(db, comment, postId, account, parentCommentId = null) {
  const user = comment.user ?? {};
  upsertComment(db, {
    externalCommentId: String(comment.pk ?? comment.id ?? ""),
    id: stableId("comment", comment.pk ?? comment.id ?? comment.text, postId),
    postId,
    authorUsername: user.username,
    authorDisplayName: user.full_name,
    text: comment.text ?? "",
    createdAt: timestampToIso(comment.created_at ?? comment.created_at_utc),
    parentCommentId,
    isOwn: String(user.pk ?? user.id ?? "") === String(account.external_user_id),
    isLiked: Boolean(comment.has_liked_comment),
    source: "cookie",
    raw: comment,
  });
}

function mergeGraphComment(db, comment, postId, parentCommentId = null) {
  const from = comment.from ?? {};
  upsertComment(db, {
    externalCommentId: String(comment.id ?? ""),
    id: stableId("comment", comment.id ?? comment.text, postId),
    postId,
    authorUsername: comment.username ?? from.username ?? `user_${from.id ?? "unknown"}`,
    authorDisplayName: from.name ?? comment.username ?? "",
    text: comment.text ?? "",
    createdAt: timestampToIso(comment.timestamp),
    parentCommentId,
    isLiked: Number(comment.like_count ?? 0) > 0,
    source: "graph",
    raw: comment,
  });
}

function completeSync(db, runId, counts) {
  db.prepare(`
    update sync_runs set status='succeeded', counts_json=?, completed_at=? where id=?
  `).run(json(counts, {}), nowIso(), runId);
}

function failSync(db, runId, error) {
  db.prepare(`
    update sync_runs set status='failed', error=?, completed_at=? where id=?
  `).run(error instanceof Error ? error.message : String(error), nowIso(), runId);
}

export async function runWebAction(kind, target, input = {}, options = {}) {
  const db = getDb();
  const account = defaultAccount(db);
  const actionId = createRunId("action");
  const liveWrites = options.yes || process.env.GRAMCLAW_ENABLE_LIVE_WRITES === "1";
  if (!liveWrites) {
    db.prepare(`
      insert into action_queue(
        id, account_id, kind, target_id, body, payload_json, status, transport, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, 'draft', 'cookie', ?, ?)
    `).run(actionId, account?.id ?? "acct_unknown", kind, target ?? null, input.text ?? "", json(input, {}), nowIso(), nowIso());
    return { ok: true, draft: true, actionId, message: "Saved locally. Re-run with --yes to send." };
  }
  const credentials = await resolveCredentials(options);
  const post = target
    ? db.prepare("select * from posts where id=? or external_media_id=? or shortcode=? limit 1").get(target, target, target)
    : null;
  const profile = target
    ? db.prepare("select * from profiles where id=? or external_user_id=? or username=? limit 1").get(target, target, normalizeUsername(target))
    : null;
  const mediaId = post?.external_media_id ?? target;
  const userId = profile?.external_user_id ?? target;
  const routes = {
    like: { path: `/api/v1/web/likes/${mediaId}/like/` },
    unlike: { path: `/api/v1/web/likes/${mediaId}/unlike/` },
    save: { path: `/api/v1/web/save/${mediaId}/save/` },
    unsave: { path: `/api/v1/web/save/${mediaId}/unsave/` },
    follow: { path: `/api/v1/web/friendships/${userId}/follow/` },
    unfollow: { path: `/api/v1/web/friendships/${userId}/unfollow/` },
    block: { path: `/api/v1/web/friendships/${userId}/block/` },
    unblock: { path: `/api/v1/web/friendships/${userId}/unblock/` },
    comment: { path: `/api/v1/web/comments/${mediaId}/add/`, form: { comment_text: input.text, replied_to_comment_id: input.replyTo } },
    "delete-comment": { path: `/api/v1/web/comments/${mediaId}/delete/${input.commentId}/` },
  };
  if (kind === "dm") {
    const form = {
      action: "send_item",
      client_context: randomUUID(),
      text: input.text,
      ...(String(target).startsWith("thread_") || /^\d+$/.test(String(target))
        ? { thread_ids: JSON.stringify([target]) }
        : { recipient_users: JSON.stringify([[userId]]) }),
    };
    const result = await webRequest("/api/v1/direct_v2/threads/broadcast/text/", {
      ...options,
      credentials,
      method: "POST",
      form,
    });
    recordSentAction(db, actionId, account, kind, target, input, result);
    return { ok: true, actionId, transport: "cookie", result };
  }
  const route = routes[kind];
  if (!route) throw new Error(`Unsupported Instagram web action: ${kind}`);
  const result = await webRequest(route.path, {
    ...options,
    credentials,
    method: "POST",
    ...(route.form ? { form: route.form } : {}),
  });
  recordSentAction(db, actionId, account, kind, target, input, result);
  return { ok: true, actionId, transport: "cookie", result };
}

function recordSentAction(db, actionId, account, kind, target, input, result) {
  db.prepare(`
    insert into action_queue(
      id, account_id, kind, target_id, body, payload_json, status,
      transport, remote_id, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, 'sent', 'cookie', ?, ?, ?)
  `).run(
    actionId,
    account?.id ?? "acct_unknown",
    kind,
    target ?? null,
    input.text ?? "",
    json(input, {}),
    result?.id ?? result?.comment?.pk ?? result?.payload?.item_id ?? null,
    nowIso(),
    nowIso(),
  );
}

export async function uploadWebPhoto(input, options = {}) {
  if (!(options.yes || process.env.GRAMCLAW_ENABLE_LIVE_WRITES === "1")) {
    const db = getDb();
    const account = defaultAccount(db);
    const actionId = createRunId("action");
    db.prepare(`
      insert into action_queue(
        id, account_id, kind, target_id, body, payload_json, status, transport, created_at, updated_at
      ) values (?, ?, ?, null, ?, ?, 'draft', 'cookie', ?, ?)
    `).run(actionId, account?.id ?? "acct_unknown", input.story ? "story" : "post", input.caption ?? "", json(input, {}), nowIso(), nowIso());
    return { ok: true, draft: true, actionId, message: "Saved locally. Re-run with --yes to publish." };
  }
  const credentials = await resolveCredentials(options);
  const bytes = readFileSync(input.file);
  const dimensions = imageSize(bytes);
  const uploadId = String(Date.now());
  const entityName = `fb_uploader_${uploadId}`;
  const params = {
    media_type: 1,
    upload_id: uploadId,
    upload_media_height: dimensions.height ?? 1080,
    upload_media_width: dimensions.width ?? 1080,
    xsharing_user_ids: "[]",
    image_compression: JSON.stringify({
      lib_name: "moz",
      lib_version: "3.1.m",
      quality: "90",
      original_width: dimensions.width ?? 1080,
      original_height: dimensions.height ?? 1080,
    }),
  };
  const uploadCandidates = [
    `/rupload_igphoto/${entityName}`,
    `/rupload_igphoto/${uploadId}_0_${Math.floor(Math.random() * 9_000_000_000 + 1_000_000_000)}`,
  ];
  let uploaded;
  let lastError;
  for (const path of uploadCandidates) {
    try {
      uploaded = await webRequest(path, {
        ...options,
        credentials,
        method: "POST",
        body: bytes,
        appId: "1217981644879628",
        referer: `${WEB_BASE}/create/details/`,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(bytes.byteLength),
          "x-entity-length": String(bytes.byteLength),
          "x-entity-name": entityName,
          "x-entity-type": "image/jpeg",
          "x-instagram-rupload-params": JSON.stringify(params),
          offset: "0",
        },
      });
      if (uploaded.upload_id) break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!uploaded?.upload_id) throw lastError ?? new Error("Instagram photo upload failed.");
  const configurePaths = input.story
    ? ["/api/v1/web/create/configure_to_story/", "/create/configure_to_story/"]
    : ["/api/v1/media/configure/", "/create/configure/"];
  const configureForm = {
    upload_id: uploaded.upload_id,
    caption: input.caption ?? "",
    source_type: "4",
    timezone_offset: String(-new Date().getTimezoneOffset() * 60),
    edits: JSON.stringify({
      crop_original_size: [dimensions.width ?? 1080, dimensions.height ?? 1080],
      crop_center: [0, 0],
      crop_zoom: 1,
    }),
  };
  let result;
  for (const path of configurePaths) {
    try {
      result = await webRequest(path, {
        ...options,
        credentials,
        method: "POST",
        form: configureForm,
        referer: `${WEB_BASE}/create/details/`,
      });
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!result) throw lastError ?? new Error("Instagram media configure failed.");
  const db = getDb();
  const account = defaultAccount(db);
  const actionId = createRunId("action");
  recordSentAction(db, actionId, account, input.story ? "story" : "post", null, {
    text: input.caption,
    file: basename(input.file),
  }, result);
  return {
    ok: true,
    actionId,
    transport: "cookie",
    uploadId: uploaded.upload_id,
    mediaId: result.media?.pk ?? result.media?.id ?? null,
    result,
  };
}
