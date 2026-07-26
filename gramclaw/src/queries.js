import { defaultAccount } from "./db.js";
import { parseJson, parseLimit } from "./utils.js";

function ftsQuery(input) {
  const tokens = String(input ?? "")
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/["*:^(){}[\]-]/g, ""))
    .filter(Boolean);
  return tokens.map((token) => `"${token}"*`).join(" AND ");
}

function parseRow(row) {
  if (!row) return row;
  return {
    ...row,
    is_own: Boolean(row.is_own),
    is_verified: row.is_verified === undefined ? undefined : Boolean(row.is_verified),
    is_private: row.is_private === undefined ? undefined : Boolean(row.is_private),
    liked: row.liked === undefined ? undefined : Boolean(row.liked),
    saved: row.saved === undefined ? undefined : Boolean(row.saved),
    media: row.media_json ? parseJson(row.media_json, []) : row.media,
    raw: row.raw_json ? parseJson(row.raw_json, {}) : row.raw,
    location: row.location_json ? parseJson(row.location_json, {}) : row.location,
  };
}

export function getStatus(db) {
  const account = defaultAccount(db);
  const counts = {};
  for (const [label, table] of [
    ["profiles", "profiles"],
    ["posts", "posts"],
    ["media", "media"],
    ["comments", "comments"],
    ["saved", "collections where kind='saved'"],
    ["liked", "collections where kind='liked'"],
    ["dmThreads", "dm_threads"],
    ["dmMessages", "dm_messages"],
    ["followers", "follow_edges where direction='followers' and current=1"],
    ["following", "follow_edges where direction='following' and current=1"],
    ["drafts", "action_queue where status in ('draft','queued')"],
    ["analyzed", "media_analysis where status='completed'"],
    ["analysisFailed", "media_analysis where status='failed'"],
    ["smartCollections", "library_collections"],
    ["boards", "boards"],
  ]) {
    counts[label] = Number(db.prepare(`select count(*) as count from ${table}`).get().count);
  }
  const lastImport = db.prepare("select * from import_runs order by started_at desc limit 1").get() ?? null;
  const lastSync = db.prepare("select * from sync_runs order by started_at desc limit 1").get() ?? null;
  return {
    ok: true,
    account,
    counts,
    lastImport: lastImport ? { ...lastImport, counts: parseJson(lastImport.counts_json, {}) } : null,
    lastSync: lastSync ? { ...lastSync, counts: parseJson(lastSync.counts_json, {}) } : null,
  };
}

export function listPosts(db, options = {}) {
  const account = defaultAccount(db);
  const limit = parseLimit(options.limit, 50);
  const offset = Math.max(0, Number.parseInt(String(options.offset ?? 0), 10) || 0);
  const conditions = ["posts.deleted_at is null"];
  const params = [];
  let ftsJoin = "";
  if (options.query) {
    ftsJoin = "join posts_fts on posts_fts.post_id=posts.id";
    conditions.push("posts_fts match ?");
    params.push(ftsQuery(options.query));
  }
  if (options.kind) {
    const kinds = Array.isArray(options.kind) ? options.kind : String(options.kind).split(",");
    const normalized = kinds.map((kind) => kind.trim()).filter(Boolean);
    if (normalized.length) {
      conditions.push(`posts.kind in (${normalized.map(() => "?").join(",")})`);
      params.push(...normalized);
    }
  }
  if (options.author) {
    conditions.push("profiles.username=?");
    params.push(String(options.author).replace(/^@/, "").toLowerCase());
  }
  if (options.own) conditions.push("posts.is_own=1");
  if (options.since) {
    conditions.push("posts.created_at>=?");
    params.push(options.since);
  }
  if (options.until) {
    conditions.push("posts.created_at<=?");
    params.push(options.until);
  }
  if (options.collection === "saved" || options.saved) {
    conditions.push("exists(select 1 from collections c where c.post_id=posts.id and c.kind='saved')");
  }
  if (options.collection === "liked" || options.liked) {
    conditions.push("exists(select 1 from collections c where c.post_id=posts.id and c.kind='liked')");
  }
  params.push(limit, offset);
  const rows = db.prepare(`
    select
      posts.*,
      profiles.username as author_username,
      profiles.display_name as author_display_name,
      profiles.avatar_url as author_avatar_url,
      profiles.followers_count as author_followers_count,
      profiles.is_verified as author_is_verified,
      exists(select 1 from collections c where c.account_id=? and c.post_id=posts.id and c.kind='liked') as liked,
      exists(select 1 from collections c where c.account_id=? and c.post_id=posts.id and c.kind='saved') as saved
    from posts
    ${ftsJoin}
    join profiles on profiles.id=posts.author_profile_id
    where ${conditions.join(" and ")}
    order by coalesce(posts.created_at, '') desc, posts.id desc
    limit ? offset ?
  `).all(account?.id ?? "", account?.id ?? "", ...params).map(parseRow);
  attachMedia(db, rows);
  return { items: rows, nextOffset: rows.length === limit ? offset + rows.length : null };
}

function attachMedia(db, rows) {
  if (!rows.length) return rows;
  const placeholders = rows.map(() => "?").join(",");
  const mediaRows = db.prepare(`
    select
      media.*,
      media_analysis.status as analysis_status,
      media_analysis.provider as analysis_provider,
      media_analysis.description as analysis_description,
      media_analysis.ocr_text as analysis_ocr_text,
      media_analysis.colors_json as analysis_colors_json,
      media_analysis.objects_json as analysis_objects_json,
      media_analysis.style_json as analysis_style_json
    from media
    left join media_analysis on media_analysis.media_id=media.id
    where media.post_id in (${placeholders})
    order by coalesce(media.created_at, ''), media.id
  `).all(...rows.map((row) => row.id)).map((row) => ({
    ...parseRow(row),
    analysis: row.analysis_status ? {
      status: row.analysis_status,
      provider: row.analysis_provider,
      description: row.analysis_description ?? "",
      ocrText: row.analysis_ocr_text ?? "",
      colors: parseJson(row.analysis_colors_json, []),
      objects: parseJson(row.analysis_objects_json, []),
      style: parseJson(row.analysis_style_json, {}),
    } : null,
  }));
  const map = new Map();
  for (const media of mediaRows) {
    if (!map.has(media.post_id)) map.set(media.post_id, []);
    map.get(media.post_id).push(media);
  }
  for (const row of rows) row.media = map.get(row.id) ?? [];
  return rows;
}

export function getPost(db, idOrShortcode) {
  const account = defaultAccount(db);
  const row = db.prepare(`
    select
      posts.*,
      profiles.username as author_username,
      profiles.display_name as author_display_name,
      profiles.avatar_url as author_avatar_url,
      profiles.biography as author_biography,
      profiles.followers_count as author_followers_count,
      profiles.is_verified as author_is_verified,
      exists(select 1 from collections c where c.account_id=? and c.post_id=posts.id and c.kind='liked') as liked,
      exists(select 1 from collections c where c.account_id=? and c.post_id=posts.id and c.kind='saved') as saved
    from posts
    join profiles on profiles.id=posts.author_profile_id
    where posts.id=? or posts.shortcode=? or posts.external_media_id=?
    limit 1
  `).get(account?.id ?? "", account?.id ?? "", idOrShortcode, idOrShortcode, idOrShortcode);
  if (!row) return null;
  const post = parseRow(row);
  attachMedia(db, [post]);
  post.comments = db.prepare(`
    select comments.*, profiles.username as author_username, profiles.display_name as author_display_name,
      profiles.avatar_url as author_avatar_url
    from comments left join profiles on profiles.id=comments.author_profile_id
    where comments.post_id=?
    order by coalesce(comments.created_at, '') asc
  `).all(post.id).map(parseRow);
  post.libraryCollections = db.prepare(`
    select
      library_collections.id,
      library_collections.name,
      library_collections.color,
      library_collection_items.source
    from library_collection_items
    join library_collections on library_collections.id=library_collection_items.collection_id
    where library_collection_items.post_id=?
    order by library_collections.name
  `).all(post.id);
  post.tags = db.prepare(`
    select tags.id, tags.name, tags.color
    from post_tags join tags on tags.id=post_tags.tag_id
    where post_tags.post_id=? order by tags.name
  `).all(post.id);
  return post;
}

export function searchComments(db, query, options = {}) {
  const limit = parseLimit(options.limit, 50);
  return db.prepare(`
    select comments.*, profiles.username as author_username, posts.permalink, posts.caption as post_caption
    from comments_fts
    join comments on comments.id=comments_fts.comment_id
    left join profiles on profiles.id=comments.author_profile_id
    left join posts on posts.id=comments.post_id
    where comments_fts match ?
    order by coalesce(comments.created_at, '') desc
    limit ?
  `).all(ftsQuery(query), limit).map(parseRow);
}

export function listThreads(db, options = {}) {
  const limit = parseLimit(options.limit, 50);
  const conditions = [];
  const params = [];
  if (options.needsReply) conditions.push("dm_threads.needs_reply=1");
  if (options.query) {
    conditions.push("(dm_threads.title like ? or exists(select 1 from dms_fts where dms_fts.thread_title like ? and dms_fts.message_id in (select id from dm_messages where thread_id=dm_threads.id)))");
    params.push(`%${options.query}%`, `%${options.query}%`);
  }
  params.push(limit);
  return db.prepare(`
    select
      dm_threads.*,
      (
        select text from dm_messages
        where dm_messages.thread_id=dm_threads.id
        order by coalesce(created_at, '') desc, id desc limit 1
      ) as last_message,
      (
        select direction from dm_messages
        where dm_messages.thread_id=dm_threads.id
        order by coalesce(created_at, '') desc, id desc limit 1
      ) as last_direction,
      (
        select group_concat(profiles.username, ', ')
        from dm_participants join profiles on profiles.id=dm_participants.profile_id
        where dm_participants.thread_id=dm_threads.id
      ) as participants
    from dm_threads
    ${conditions.length ? `where ${conditions.join(" and ")}` : ""}
    order by coalesce(last_message_at, '') desc
    limit ?
  `).all(...params).map(parseRow);
}

export function getThread(db, threadId, options = {}) {
  const thread = db.prepare("select * from dm_threads where id=? or thread_path=? limit 1").get(threadId, threadId);
  if (!thread) return null;
  const limit = parseLimit(options.limit, 500, 5000);
  return {
    ...parseRow(thread),
    participants: db.prepare(`
      select profiles.* from dm_participants
      join profiles on profiles.id=dm_participants.profile_id
      where dm_participants.thread_id=?
      order by profiles.display_name
    `).all(thread.id).map(parseRow),
    messages: db.prepare(`
      select dm_messages.*, profiles.username as sender_username, profiles.display_name as sender_display_name,
        profiles.avatar_url as sender_avatar_url
      from dm_messages left join profiles on profiles.id=dm_messages.sender_profile_id
      where dm_messages.thread_id=?
      order by coalesce(dm_messages.created_at, '') asc, dm_messages.id asc
      limit ?
    `).all(thread.id, limit).map((row) => ({
      ...parseRow(row),
      reactions: parseJson(row.reactions_json, []),
      share: parseJson(row.share_json, {}),
      media: parseJson(row.media_json, []),
    })),
  };
}

export function searchDms(db, query, options = {}) {
  const limit = parseLimit(options.limit, 50);
  return db.prepare(`
    select dm_messages.*, dm_threads.title as thread_title,
      profiles.username as sender_username, profiles.display_name as sender_display_name
    from dms_fts
    join dm_messages on dm_messages.id=dms_fts.message_id
    join dm_threads on dm_threads.id=dm_messages.thread_id
    left join profiles on profiles.id=dm_messages.sender_profile_id
    where dms_fts match ?
    order by coalesce(dm_messages.created_at, '') desc
    limit ?
  `).all(ftsQuery(query), limit).map(parseRow);
}

export function getInbox(db, options = {}) {
  const limit = parseLimit(options.limit, 30);
  const dms = db.prepare(`
    select 'dm' as item_kind, dm_messages.id, dm_messages.thread_id as context_id,
      dm_messages.text, dm_messages.created_at, dm_messages.direction,
      dm_threads.title, profiles.username as author_username,
      profiles.display_name as author_display_name, profiles.followers_count
    from dm_messages
    join dm_threads on dm_threads.id=dm_messages.thread_id
    left join profiles on profiles.id=dm_messages.sender_profile_id
    where dm_messages.direction='inbound'
    order by coalesce(dm_messages.created_at, '') desc
    limit ?
  `).all(limit);
  const comments = db.prepare(`
    select 'comment' as item_kind, comments.id, comments.post_id as context_id,
      comments.text, comments.created_at, 'inbound' as direction,
      substr(posts.caption, 1, 100) as title, profiles.username as author_username,
      profiles.display_name as author_display_name, profiles.followers_count
    from comments
    left join posts on posts.id=comments.post_id
    left join profiles on profiles.id=comments.author_profile_id
    where comments.is_own=0
    order by coalesce(comments.created_at, '') desc
    limit ?
  `).all(limit);
  return [...dms, ...comments]
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
    .slice(0, limit)
    .map((item) => ({
      ...item,
      score: inboxScore(item),
    }))
    .sort((a, b) => b.score - a.score || String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
}

function inboxScore(item) {
  const followers = Math.max(0, Number(item.followers_count ?? 0));
  const context = Math.min(35, Math.round(Math.log10(followers + 1) * 9));
  const intent = /\b(collab|project|quote|budget|feature|interview|available|deadline|send|review|question)\b/i.test(item.text)
    ? 35
    : 12;
  const length = Math.min(20, Math.round(String(item.text ?? "").length / 18));
  return Math.min(100, 25 + context + intent + length);
}

export function graphQuery(db, kind, options = {}) {
  const account = defaultAccount(db);
  if (!account) return [];
  const limit = parseLimit(options.limit, 100);
  if (kind === "summary") {
    const followers = Number(db.prepare(
      "select count(*) as count from follow_edges where account_id=? and direction='followers' and current=1",
    ).get(account.id).count);
    const following = Number(db.prepare(
      "select count(*) as count from follow_edges where account_id=? and direction='following' and current=1",
    ).get(account.id).count);
    const mutuals = Number(db.prepare(`
      select count(*) as count from follow_edges f
      join follow_edges g on g.account_id=f.account_id and g.profile_id=f.profile_id
      where f.account_id=? and f.direction='followers' and f.current=1
        and g.direction='following' and g.current=1
    `).get(account.id).count);
    const ended30d = Number(db.prepare(`
      select count(*) as count from follow_events
      where account_id=? and event_type='ended' and event_at>=datetime('now','-30 days')
    `).get(account.id).count);
    return { account: account.username, followers, following, mutuals, nonMutualFollowing: Math.max(0, following - mutuals), ended30d };
  }
  if (kind === "events" || kind === "unfollowed") {
    const eventType = kind === "unfollowed" ? "ended" : options.event;
    const where = ["follow_events.account_id=?"];
    const params = [account.id];
    if (eventType) {
      where.push("follow_events.event_type=?");
      params.push(eventType);
    }
    if (options.since) {
      where.push("follow_events.event_at>=?");
      params.push(options.since);
    }
    params.push(limit);
    return db.prepare(`
      select follow_events.*, profiles.username, profiles.display_name, profiles.avatar_url, profiles.followers_count
      from follow_events join profiles on profiles.id=follow_events.profile_id
      where ${where.join(" and ")}
      order by follow_events.event_at desc limit ?
    `).all(...params).map(parseRow);
  }
  const baseSelect = `
    select profiles.*, f.first_seen_at, f.last_seen_at
    from follow_edges f join profiles on profiles.id=f.profile_id
  `;
  if (kind === "mutuals") {
    return db.prepare(`${baseSelect}
      join follow_edges g on g.account_id=f.account_id and g.profile_id=f.profile_id
      where f.account_id=? and f.direction='followers' and f.current=1
        and g.direction='following' and g.current=1
      order by profiles.followers_count desc limit ?
    `).all(account.id, limit).map(parseRow);
  }
  if (kind === "non-mutual-following") {
    return db.prepare(`${baseSelect}
      where f.account_id=? and f.direction='following' and f.current=1
        and not exists(
          select 1 from follow_edges g
          where g.account_id=f.account_id and g.profile_id=f.profile_id
            and g.direction='followers' and g.current=1
        )
      order by profiles.followers_count desc limit ?
    `).all(account.id, limit).map(parseRow);
  }
  if (kind === "top-followers") {
    return db.prepare(`${baseSelect}
      where f.account_id=? and f.direction='followers' and f.current=1
      order by profiles.followers_count desc limit ?
    `).all(account.id, limit).map(parseRow);
  }
  throw new Error(`Unknown graph query: ${kind}`);
}

export function getInsights(db) {
  const account = defaultAccount(db);
  const posting = db.prepare(`
    select
      count(*) as posts,
      round(avg(like_count), 1) as avg_likes,
      round(avg(comment_count), 1) as avg_comments,
      max(like_count) as top_likes,
      min(created_at) as first_post_at,
      max(created_at) as last_post_at
    from posts where deleted_at is null and kind<>'placeholder'
  `).get();
  const byKind = db.prepare(`
    select kind, count(*) as count, round(avg(like_count), 1) as avg_likes,
      round(avg(comment_count), 1) as avg_comments
    from posts where deleted_at is null and kind<>'placeholder'
    group by kind order by count desc
  `).all();
  const byMonth = db.prepare(`
    select substr(created_at, 1, 7) as month, count(*) as posts,
      sum(like_count) as likes, sum(comment_count) as comments
    from posts
    where created_at is not null and deleted_at is null and kind<>'placeholder'
    group by substr(created_at, 1, 7)
    order by month desc limit 24
  `).all().reverse();
  const topPosts = listPosts(db, { own: true, limit: 100 }).items
    .sort((a, b) => (b.like_count + b.comment_count * 3) - (a.like_count + a.comment_count * 3))
    .slice(0, 5);
  const themes = keywordThemes(db);
  return { account, posting, byKind, byMonth, topPosts, themes };
}

function keywordThemes(db) {
  const stop = new Set(["this","that","with","from","your","have","about","into","over","more","than","just","when","what","where","were","they","them","their","been","will","would","could","should","some","also","very","like","make","made","only","first","after","before","again","instagram"]);
  const rows = db.prepare("select caption from posts where caption<>'' and deleted_at is null").all();
  const counts = new Map();
  for (const row of rows) {
    for (const token of row.caption.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []) {
      if (stop.has(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([label, count]) => ({ label, count }));
}

export function listProfiles(db, options = {}) {
  const limit = parseLimit(options.limit, 50);
  const query = String(options.query ?? "").trim();
  return db.prepare(`
    select * from profiles
    ${query ? "where username like ? or display_name like ? or biography like ?" : ""}
    order by followers_count desc, username asc
    limit ?
  `).all(...(query ? [`%${query}%`, `%${query}%`, `%${query}%`] : []), limit).map(parseRow);
}

export function getProfile(db, usernameOrId) {
  const normalized = String(usernameOrId).replace(/^@/, "").toLowerCase();
  const profile = db.prepare(`
    select * from profiles
    where id=? or external_user_id=? or username=?
    limit 1
  `).get(usernameOrId, usernameOrId, normalized);
  if (!profile) return null;
  return {
    ...parseRow(profile),
    recentPosts: listPosts(db, { author: profile.username, limit: 12 }).items,
    relationship: {
      followsYou: Boolean(db.prepare(
        "select 1 from follow_edges where profile_id=? and direction='followers' and current=1 limit 1",
      ).get(profile.id)),
      youFollow: Boolean(db.prepare(
        "select 1 from follow_edges where profile_id=? and direction='following' and current=1 limit 1",
      ).get(profile.id)),
    },
  };
}
