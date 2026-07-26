import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { ensureDirs } from "./config.js";
import { json, nowIso, stableId } from "./utils.js";

let database;
let databasePath;

const SCHEMA = `
create table if not exists accounts (
  id text primary key,
  username text not null unique,
  display_name text not null default '',
  external_user_id text,
  biography text not null default '',
  avatar_url text,
  is_default integer not null default 0,
  transport text not null default 'archive',
  created_at text not null,
  updated_at text not null
);

create table if not exists profiles (
  id text primary key,
  external_user_id text,
  username text not null unique,
  display_name text not null default '',
  biography text not null default '',
  avatar_url text,
  website text,
  followers_count integer not null default 0,
  following_count integer not null default 0,
  media_count integer not null default 0,
  is_verified integer not null default 0,
  is_private integer not null default 0,
  raw_json text not null default '{}',
  first_seen_at text not null,
  last_seen_at text not null
);

create unique index if not exists profiles_external_id_idx
  on profiles(external_user_id) where external_user_id is not null;

create table if not exists profile_snapshots (
  profile_id text not null,
  snapshot_hash text not null,
  observed_at text not null,
  source text not null,
  raw_json text not null default '{}',
  primary key(profile_id, snapshot_hash)
);

create table if not exists posts (
  id text primary key,
  external_media_id text,
  shortcode text,
  account_id text not null,
  author_profile_id text not null,
  kind text not null check(kind in ('post','carousel','reel','story','archived','placeholder')),
  caption text not null default '',
  alt_text text not null default '',
  created_at text,
  permalink text,
  like_count integer not null default 0,
  comment_count integer not null default 0,
  view_count integer not null default 0,
  play_count integer not null default 0,
  is_own integer not null default 0,
  location_json text not null default '{}',
  raw_json text not null default '{}',
  source text not null,
  deleted_at text,
  updated_at text not null
);

create unique index if not exists posts_external_media_idx
  on posts(external_media_id) where external_media_id is not null;
create unique index if not exists posts_shortcode_idx
  on posts(shortcode) where shortcode is not null;
create index if not exists posts_created_idx on posts(created_at desc);
create index if not exists posts_author_idx on posts(author_profile_id, created_at desc);
create index if not exists posts_kind_idx on posts(kind, created_at desc);

create table if not exists media (
  id text primary key,
  post_id text,
  dm_message_id text,
  media_type text not null default 'image',
  local_path text,
  remote_url text,
  thumbnail_url text,
  width integer,
  height integer,
  duration_ms integer,
  alt_text text not null default '',
  source text not null,
  raw_json text not null default '{}',
  created_at text,
  updated_at text not null
);

create index if not exists media_post_idx on media(post_id);
create index if not exists media_dm_idx on media(dm_message_id);

create table if not exists comments (
  id text primary key,
  external_comment_id text,
  post_id text,
  author_profile_id text,
  text text not null,
  created_at text,
  parent_comment_id text,
  is_own integer not null default 0,
  is_liked integer not null default 0,
  source text not null,
  raw_json text not null default '{}'
);

create index if not exists comments_post_idx on comments(post_id, created_at desc);
create index if not exists comments_created_idx on comments(created_at desc);

create table if not exists collections (
  account_id text not null,
  post_id text not null,
  kind text not null check(kind in ('liked','saved')),
  collected_at text,
  source text not null,
  raw_json text not null default '{}',
  updated_at text not null,
  primary key(account_id, post_id, kind)
);

create index if not exists collections_kind_idx on collections(account_id, kind, collected_at desc);

create table if not exists media_analysis (
  media_id text primary key,
  post_id text,
  status text not null default 'queued' check(status in ('queued','running','completed','failed')),
  provider text not null default 'local' check(provider in ('local','cloud')),
  description text not null default '',
  ocr_text text not null default '',
  colors_json text not null default '[]',
  objects_json text not null default '[]',
  style_json text not null default '{}',
  embedding_json text not null default '[]',
  perceptual_hash text,
  attempts integer not null default 0,
  error text,
  queued_at text not null,
  started_at text,
  completed_at text,
  updated_at text not null
);

create index if not exists media_analysis_post_idx on media_analysis(post_id);
create index if not exists media_analysis_status_idx on media_analysis(status, queued_at);
create index if not exists media_analysis_hash_idx
  on media_analysis(perceptual_hash) where perceptual_hash is not null;

create table if not exists library_collections (
  id text primary key,
  account_id text not null,
  name text not null,
  slug text not null,
  description text not null default '',
  color text not null default '#8267f5',
  kind text not null default 'custom' check(kind in ('automatic','custom')),
  rules_json text not null default '{}',
  created_at text not null,
  updated_at text not null,
  unique(account_id, slug)
);

create table if not exists library_collection_items (
  collection_id text not null,
  post_id text not null,
  source text not null default 'manual' check(source in ('automatic','manual')),
  added_at text not null,
  primary key(collection_id, post_id)
);

create index if not exists library_collection_items_post_idx
  on library_collection_items(post_id, added_at desc);

create table if not exists tags (
  id text primary key,
  account_id text not null,
  name text not null,
  slug text not null,
  color text not null default '#d8f75a',
  created_at text not null,
  unique(account_id, slug)
);

create table if not exists post_tags (
  post_id text not null,
  tag_id text not null,
  added_at text not null,
  primary key(post_id, tag_id)
);

create table if not exists boards (
  id text primary key,
  account_id text not null,
  name text not null,
  description text not null default '',
  background text not null default '#f1efe9',
  created_at text not null,
  updated_at text not null
);

create table if not exists board_items (
  id text primary key,
  board_id text not null,
  post_id text not null,
  media_id text,
  note text not null default '',
  x real not null default 0,
  y real not null default 0,
  width real not null default 280,
  height real not null default 340,
  rotation real not null default 0,
  sort_order integer not null default 0,
  created_at text not null,
  updated_at text not null
);

create index if not exists board_items_board_idx on board_items(board_id, sort_order);

create table if not exists dm_threads (
  id text primary key,
  account_id text not null,
  title text not null,
  thread_path text,
  last_message_at text,
  unread_count integer not null default 0,
  needs_reply integer not null default 0,
  source text not null,
  raw_json text not null default '{}',
  updated_at text not null
);

create table if not exists dm_participants (
  thread_id text not null,
  profile_id text not null,
  primary key(thread_id, profile_id)
);

create table if not exists dm_messages (
  id text primary key,
  external_message_id text,
  thread_id text not null,
  sender_profile_id text,
  text text not null default '',
  created_at text,
  direction text not null check(direction in ('inbound','outbound','system')),
  media_json text not null default '[]',
  reactions_json text not null default '[]',
  share_json text not null default '{}',
  is_replied integer not null default 0,
  source text not null,
  raw_json text not null default '{}'
);

create index if not exists dm_messages_thread_idx on dm_messages(thread_id, created_at desc);
create index if not exists dm_messages_created_idx on dm_messages(created_at desc);

create table if not exists follow_snapshots (
  id text primary key,
  account_id text not null,
  direction text not null check(direction in ('followers','following')),
  status text not null default 'complete',
  result_count integer not null default 0,
  source text not null,
  observed_at text not null,
  raw_json text not null default '{}'
);

create table if not exists follow_snapshot_members (
  snapshot_id text not null,
  profile_id text not null,
  primary key(snapshot_id, profile_id)
);

create table if not exists follow_edges (
  account_id text not null,
  direction text not null check(direction in ('followers','following')),
  profile_id text not null,
  current integer not null default 1,
  first_seen_at text not null,
  last_seen_at text not null,
  ended_at text,
  source text not null,
  primary key(account_id, direction, profile_id)
);

create index if not exists follow_edges_current_idx
  on follow_edges(account_id, direction, current, last_seen_at desc);

create table if not exists follow_events (
  id text primary key,
  account_id text not null,
  direction text not null,
  profile_id text not null,
  event_type text not null check(event_type in ('started','ended')),
  event_at text not null,
  source text not null,
  snapshot_id text
);

create index if not exists follow_events_time_idx on follow_events(account_id, event_at desc);

create table if not exists action_queue (
  id text primary key,
  account_id text not null,
  kind text not null,
  target_id text,
  body text not null default '',
  payload_json text not null default '{}',
  status text not null default 'draft' check(status in ('draft','queued','sent','failed')),
  transport text,
  remote_id text,
  error text,
  created_at text not null,
  updated_at text not null
);

create table if not exists import_runs (
  id text primary key,
  source_path text not null,
  status text not null,
  counts_json text not null default '{}',
  started_at text not null,
  completed_at text,
  error text
);

create table if not exists sync_runs (
  id text primary key,
  account_id text,
  stream text not null,
  transport text not null,
  status text not null,
  counts_json text not null default '{}',
  started_at text not null,
  completed_at text,
  error text
);

create table if not exists sync_cursors (
  account_id text not null,
  stream text not null,
  scope text not null default '',
  transport text not null,
  cursor text,
  updated_at text not null,
  primary key(account_id, stream, scope, transport)
);

create table if not exists raw_objects (
  id text primary key,
  object_type text not null,
  source text not null,
  source_path text,
  payload_json text not null,
  observed_at text not null
);

create virtual table if not exists posts_fts using fts5(
  post_id unindexed,
  caption,
  author,
  kind unindexed,
  tokenize='unicode61 remove_diacritics 2'
);

create virtual table if not exists comments_fts using fts5(
  comment_id unindexed,
  text,
  author,
  tokenize='unicode61 remove_diacritics 2'
);

create virtual table if not exists dms_fts using fts5(
  message_id unindexed,
  text,
  sender,
  thread_title,
  tokenize='unicode61 remove_diacritics 2'
);

create virtual table if not exists visual_fts using fts5(
  media_id unindexed,
  post_id unindexed,
  description,
  ocr_text,
  objects,
  style,
  tokenize='unicode61 remove_diacritics 2'
);
`;

export function getDb(options = {}) {
  const paths = ensureDirs();
  if (database && databasePath === paths.dbPath) return database;
  if (database) database.close();
  databasePath = paths.dbPath;
  const existed = existsSync(paths.dbPath);
  database = new Database(paths.dbPath);
  database.exec("pragma journal_mode = WAL; pragma foreign_keys = on; pragma busy_timeout = 5000;");
  database.exec(SCHEMA);
  database.exec("pragma user_version = 2;");
  if (options.seedDemo && !existed) seedDemoData(database);
  return database;
}

export function closeDb() {
  if (database) database.close();
  database = undefined;
  databasePath = undefined;
}

export function transaction(db, fn) {
  if (db.inTransaction) return fn();
  db.exec("begin immediate");
  try {
    const result = fn();
    db.exec("commit");
    return result;
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export function defaultAccount(db) {
  return db.prepare("select * from accounts order by is_default desc, created_at asc limit 1").get() ?? null;
}

export function ensureAccount(db, input = {}) {
  const username = String(input.username ?? "instagram_user").replace(/^@/, "").toLowerCase();
  const id = input.id ?? stableId("acct", input.externalUserId ?? username);
  const now = nowIso();
  db.prepare(`
    insert into accounts (
      id, username, display_name, external_user_id, biography, avatar_url,
      is_default, transport, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      username=excluded.username,
      display_name=case when excluded.display_name<>'' then excluded.display_name else accounts.display_name end,
      external_user_id=coalesce(excluded.external_user_id, accounts.external_user_id),
      biography=case when excluded.biography<>'' then excluded.biography else accounts.biography end,
      avatar_url=coalesce(excluded.avatar_url, accounts.avatar_url),
      is_default=max(accounts.is_default, excluded.is_default),
      transport=case when excluded.transport<>'archive' then excluded.transport else accounts.transport end,
      updated_at=excluded.updated_at
  `).run(
    id,
    username,
    input.displayName ?? "",
    input.externalUserId ?? null,
    input.biography ?? "",
    input.avatarUrl ?? null,
    input.isDefault === false ? 0 : 1,
    input.transport ?? "archive",
    now,
    now,
  );
  upsertProfile(db, {
    id: input.profileId ?? stableId("profile", input.externalUserId ?? username),
    externalUserId: input.externalUserId,
    username,
    displayName: input.displayName ?? username,
    biography: input.biography ?? "",
    avatarUrl: input.avatarUrl,
    source: input.transport ?? "archive",
  });
  return db.prepare("select * from accounts where id=?").get(id);
}

export function upsertProfile(db, input) {
  const username = String(input.username ?? input.displayName ?? "unknown")
    .replace(/^@/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .slice(0, 64) || "unknown";
  const existing = input.externalUserId
    ? db.prepare("select id from profiles where external_user_id=? or username=? limit 1").get(String(input.externalUserId), username)
    : db.prepare("select id from profiles where username=? limit 1").get(username);
  const id = existing?.id ?? input.id ?? stableId("profile", input.externalUserId ?? username);
  const now = input.observedAt ?? nowIso();
  db.prepare(`
    insert into profiles (
      id, external_user_id, username, display_name, biography, avatar_url, website,
      followers_count, following_count, media_count, is_verified, is_private,
      raw_json, first_seen_at, last_seen_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      external_user_id=coalesce(excluded.external_user_id, profiles.external_user_id),
      username=case when excluded.username not like 'unknown%' then excluded.username else profiles.username end,
      display_name=case when excluded.display_name<>'' then excluded.display_name else profiles.display_name end,
      biography=case when excluded.biography<>'' then excluded.biography else profiles.biography end,
      avatar_url=coalesce(excluded.avatar_url, profiles.avatar_url),
      website=coalesce(excluded.website, profiles.website),
      followers_count=max(profiles.followers_count, excluded.followers_count),
      following_count=max(profiles.following_count, excluded.following_count),
      media_count=max(profiles.media_count, excluded.media_count),
      is_verified=max(profiles.is_verified, excluded.is_verified),
      is_private=max(profiles.is_private, excluded.is_private),
      raw_json=case when excluded.raw_json<>'{}' then excluded.raw_json else profiles.raw_json end,
      last_seen_at=excluded.last_seen_at
  `).run(
    id,
    input.externalUserId ?? null,
    username,
    input.displayName ?? username,
    input.biography ?? "",
    input.avatarUrl ?? null,
    input.website ?? null,
    Number(input.followersCount ?? 0),
    Number(input.followingCount ?? 0),
    Number(input.mediaCount ?? 0),
    input.isVerified ? 1 : 0,
    input.isPrivate ? 1 : 0,
    json(input.raw, {}),
    now,
    now,
  );
  return db.prepare("select * from profiles where id=?").get(id);
}

export function upsertPost(db, input) {
  const account = input.accountId
    ? db.prepare("select * from accounts where id=?").get(input.accountId)
    : defaultAccount(db) ?? ensureAccount(db);
  const author = input.authorProfileId
    ? db.prepare("select * from profiles where id=?").get(input.authorProfileId)
    : upsertProfile(db, {
        username: input.authorUsername ?? account.username,
        displayName: input.authorDisplayName ?? input.authorUsername ?? account.display_name,
        externalUserId: input.authorExternalUserId,
        source: input.source,
      });
  const id = input.id ?? stableId(
    "post",
    input.externalMediaId ?? input.shortcode ?? input.permalink ?? input.createdAt ?? input.caption,
  );
  const updated = nowIso();
  db.prepare(`
    insert into posts (
      id, external_media_id, shortcode, account_id, author_profile_id, kind, caption,
      alt_text, created_at, permalink, like_count, comment_count, view_count, play_count,
      is_own, location_json, raw_json, source, deleted_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      external_media_id=coalesce(excluded.external_media_id, posts.external_media_id),
      shortcode=coalesce(excluded.shortcode, posts.shortcode),
      author_profile_id=excluded.author_profile_id,
      kind=case when posts.kind='placeholder' then excluded.kind else posts.kind end,
      caption=case when excluded.caption<>'' then excluded.caption else posts.caption end,
      alt_text=case when excluded.alt_text<>'' then excluded.alt_text else posts.alt_text end,
      created_at=coalesce(excluded.created_at, posts.created_at),
      permalink=coalesce(excluded.permalink, posts.permalink),
      like_count=max(posts.like_count, excluded.like_count),
      comment_count=max(posts.comment_count, excluded.comment_count),
      view_count=max(posts.view_count, excluded.view_count),
      play_count=max(posts.play_count, excluded.play_count),
      is_own=max(posts.is_own, excluded.is_own),
      location_json=case when excluded.location_json<>'{}' then excluded.location_json else posts.location_json end,
      raw_json=case when excluded.raw_json<>'{}' then excluded.raw_json else posts.raw_json end,
      source=excluded.source,
      deleted_at=coalesce(excluded.deleted_at, posts.deleted_at),
      updated_at=excluded.updated_at
  `).run(
    id,
    input.externalMediaId ?? null,
    input.shortcode ?? null,
    account.id,
    author.id,
    input.kind ?? "post",
    input.caption ?? "",
    input.altText ?? "",
    input.createdAt ?? null,
    input.permalink ?? null,
    Number(input.likeCount ?? 0),
    Number(input.commentCount ?? 0),
    Number(input.viewCount ?? 0),
    Number(input.playCount ?? 0),
    input.isOwn ? 1 : 0,
    json(input.location, {}),
    json(input.raw, {}),
    input.source ?? "archive",
    input.deletedAt ?? null,
    updated,
  );
  return db.prepare("select * from posts where id=?").get(id);
}

export function upsertMedia(db, input) {
  const id = input.id ?? stableId(
    "media",
    input.postId ?? input.dmMessageId,
    input.localPath ?? input.remoteUrl ?? input.index ?? 0,
  );
  db.prepare(`
    insert into media (
      id, post_id, dm_message_id, media_type, local_path, remote_url, thumbnail_url,
      width, height, duration_ms, alt_text, source, raw_json, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      local_path=coalesce(excluded.local_path, media.local_path),
      remote_url=coalesce(excluded.remote_url, media.remote_url),
      thumbnail_url=coalesce(excluded.thumbnail_url, media.thumbnail_url),
      width=coalesce(excluded.width, media.width),
      height=coalesce(excluded.height, media.height),
      duration_ms=coalesce(excluded.duration_ms, media.duration_ms),
      alt_text=case when excluded.alt_text<>'' then excluded.alt_text else media.alt_text end,
      raw_json=case when excluded.raw_json<>'{}' then excluded.raw_json else media.raw_json end,
      updated_at=excluded.updated_at
  `).run(
    id,
    input.postId ?? null,
    input.dmMessageId ?? null,
    input.mediaType ?? "image",
    input.localPath ?? null,
    input.remoteUrl ?? null,
    input.thumbnailUrl ?? null,
    input.width ?? null,
    input.height ?? null,
    input.durationMs ?? null,
    input.altText ?? "",
    input.source ?? "archive",
    json(input.raw, {}),
    input.createdAt ?? null,
    nowIso(),
  );
  return id;
}

export function upsertComment(db, input) {
  const author = input.authorProfileId
    ? db.prepare("select * from profiles where id=?").get(input.authorProfileId)
    : input.authorUsername
      ? upsertProfile(db, {
          username: input.authorUsername,
          displayName: input.authorDisplayName ?? input.authorUsername,
          source: input.source,
        })
      : null;
  const id = input.id ?? stableId(
    "comment",
    input.externalCommentId ?? input.postId,
    input.createdAt,
    input.text,
    author?.id,
  );
  db.prepare(`
    insert into comments (
      id, external_comment_id, post_id, author_profile_id, text, created_at,
      parent_comment_id, is_own, is_liked, source, raw_json
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      post_id=coalesce(excluded.post_id, comments.post_id),
      author_profile_id=coalesce(excluded.author_profile_id, comments.author_profile_id),
      text=excluded.text,
      is_liked=max(comments.is_liked, excluded.is_liked),
      raw_json=case when excluded.raw_json<>'{}' then excluded.raw_json else comments.raw_json end
  `).run(
    id,
    input.externalCommentId ?? null,
    input.postId ?? null,
    author?.id ?? null,
    input.text ?? "",
    input.createdAt ?? null,
    input.parentCommentId ?? null,
    input.isOwn ? 1 : 0,
    input.isLiked ? 1 : 0,
    input.source ?? "archive",
    json(input.raw, {}),
  );
  return id;
}

export function addCollection(db, input) {
  const account = input.accountId
    ? db.prepare("select * from accounts where id=?").get(input.accountId)
    : defaultAccount(db) ?? ensureAccount(db);
  db.prepare(`
    insert into collections(account_id, post_id, kind, collected_at, source, raw_json, updated_at)
    values (?, ?, ?, ?, ?, ?, ?)
    on conflict(account_id, post_id, kind) do update set
      collected_at=coalesce(excluded.collected_at, collections.collected_at),
      source=excluded.source,
      raw_json=case when excluded.raw_json<>'{}' then excluded.raw_json else collections.raw_json end,
      updated_at=excluded.updated_at
  `).run(
    account.id,
    input.postId,
    input.kind,
    input.collectedAt ?? null,
    input.source ?? "archive",
    json(input.raw, {}),
    nowIso(),
  );
}

export function rebuildFts(db) {
  transaction(db, () => {
    db.exec("delete from posts_fts; delete from comments_fts; delete from dms_fts; delete from visual_fts;");
    db.exec(`
      insert into posts_fts(post_id, caption, author, kind)
      select posts.id, posts.caption, profiles.username, posts.kind
      from posts join profiles on profiles.id=posts.author_profile_id
      where posts.deleted_at is null;

      insert into comments_fts(comment_id, text, author)
      select comments.id, comments.text, coalesce(profiles.username, '')
      from comments left join profiles on profiles.id=comments.author_profile_id;

      insert into dms_fts(message_id, text, sender, thread_title)
      select dm_messages.id, dm_messages.text, coalesce(profiles.username, ''), dm_threads.title
      from dm_messages
      join dm_threads on dm_threads.id=dm_messages.thread_id
      left join profiles on profiles.id=dm_messages.sender_profile_id;

      insert into visual_fts(media_id, post_id, description, ocr_text, objects, style)
      select
        media_id,
        post_id,
        description,
        ocr_text,
        replace(replace(objects_json, '[', ''), ']', ''),
        style_json
      from media_analysis
      where status='completed';
    `);
  });
}

export function recordFollowSnapshot(db, { accountId, direction, profileIds, source, complete = true, observedAt }) {
  const time = observedAt ?? nowIso();
  const snapshotId = stableId("follow_snapshot", accountId, direction, time, source);
  const previousRows = db.prepare(
    "select profile_id from follow_edges where account_id=? and direction=? and current=1",
  ).all(accountId, direction);
  const previous = new Set(previousRows.map((row) => row.profile_id));
  const incoming = new Set(profileIds);
  transaction(db, () => {
    db.prepare(`
      insert or replace into follow_snapshots
      (id, account_id, direction, status, result_count, source, observed_at, raw_json)
      values (?, ?, ?, ?, ?, ?, ?, '{}')
    `).run(snapshotId, accountId, direction, complete ? "complete" : "partial", incoming.size, source, time);
    const member = db.prepare(
      "insert or ignore into follow_snapshot_members(snapshot_id, profile_id) values (?, ?)",
    );
    const edge = db.prepare(`
      insert into follow_edges(account_id, direction, profile_id, current, first_seen_at, last_seen_at, ended_at, source)
      values (?, ?, ?, 1, ?, ?, null, ?)
      on conflict(account_id, direction, profile_id) do update set
        current=1, last_seen_at=excluded.last_seen_at, ended_at=null, source=excluded.source
    `);
    const event = db.prepare(`
      insert or ignore into follow_events
      (id, account_id, direction, profile_id, event_type, event_at, source, snapshot_id)
      values (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const profileId of incoming) {
      member.run(snapshotId, profileId);
      edge.run(accountId, direction, profileId, time, time, source);
      if (!previous.has(profileId)) {
        event.run(stableId("follow_event", accountId, direction, profileId, "started", time), accountId, direction, profileId, "started", time, source, snapshotId);
      }
    }
    if (complete) {
      const endEdge = db.prepare(`
        update follow_edges set current=0, ended_at=?, last_seen_at=?, source=?
        where account_id=? and direction=? and profile_id=?
      `);
      for (const profileId of previous) {
        if (incoming.has(profileId)) continue;
        endEdge.run(time, time, source, accountId, direction, profileId);
        event.run(stableId("follow_event", accountId, direction, profileId, "ended", time), accountId, direction, profileId, "ended", time, source, snapshotId);
      }
    }
  });
  return { snapshotId, count: incoming.size, complete };
}

export function seedDemoData(db) {
  const existing = db.prepare("select count(*) as count from accounts").get().count;
  if (existing > 0) return { seeded: false };
  const account = ensureAccount(db, {
    id: "acct_demo",
    username: "studio.marea",
    displayName: "Marea Studio",
    biography: "Objects, spaces, and field notes from the Pacific edge.",
    isDefault: true,
  });
  const people = [
    ["linh.makes", "Linh Tran", 18200, "Ceramics and quiet mornings."],
    ["fieldnotes.sam", "Sam Rivera", 7450, "Writer · photographer · walker."],
    ["nora.works", "Nora Singh", 31200, "Independent art director."],
    ["softcorner", "Soft Corner", 9200, "A tiny shop for useful things."],
    ["kai.afterlight", "Kai Bell", 12800, "Film, light, weather."],
    ["paperandcurrent", "Paper & Current", 26400, "Print journal about material culture."],
    ["mae.studio", "Mae Studio", 5800, "Flowers, forms, and found color."],
  ].map(([username, displayName, followersCount, biography]) =>
    upsertProfile(db, { username, displayName, followersCount, biography, source: "demo" })
  );
  const samples = [
    ["post_demo_01", people[0], "post", "Glaze tests from a week of coastal fog. Keeping the failures close.", "2026-07-24T18:22:00.000Z", 842, 27],
    ["post_demo_02", people[2], "carousel", "A visual system built from tide charts, shipping labels, and one stubborn shade of red.", "2026-07-23T15:04:00.000Z", 1204, 38],
    ["post_demo_03", people[4], "reel", "Last light moving across the south wall. 22 seconds, no soundtrack.", "2026-07-22T02:46:00.000Z", 2301, 51],
    ["post_demo_04", people[1], "post", "Notes from the ferry: everyone looks up when the foghorn sounds.", "2026-07-20T20:15:00.000Z", 561, 19],
    ["post_demo_05", people[3], "carousel", "Five objects that make a small room feel finished.", "2026-07-18T17:30:00.000Z", 997, 44],
    ["post_demo_06", people[5], "post", "Issue 08 is about repair—not restoration, but the evidence of care.", "2026-07-15T11:05:00.000Z", 1738, 63],
    ["post_demo_07", people[6], "story", "Stem study, 7:12am.", "2026-07-25T14:12:00.000Z", 224, 6],
    ["post_demo_08", upsertProfile(db, { username: account.username, displayName: account.display_name, source: "demo" }), "post", "Studio shelf, July. More samples than finished things—which feels right.", "2026-07-12T16:40:00.000Z", 688, 31],
  ];
  for (const [id, author, kind, caption, createdAt, likeCount, commentCount] of samples) {
    const post = upsertPost(db, {
      id,
      accountId: account.id,
      authorProfileId: author.id,
      kind,
      caption,
      createdAt,
      likeCount,
      commentCount,
      isOwn: author.username === account.username,
      permalink: `https://www.instagram.com/p/${id.replace("post_demo_", "GCLAW")}/`,
      source: "demo",
    });
    upsertMedia(db, {
      id: `media_${id}`,
      postId: post.id,
      mediaType: kind === "reel" || kind === "story" ? "video" : "image",
      source: "demo",
      raw: { palette: Number(id.slice(-2)) },
    });
  }
  addCollection(db, { accountId: account.id, postId: "post_demo_02", kind: "saved", collectedAt: "2026-07-23T16:00:00.000Z", source: "demo" });
  addCollection(db, { accountId: account.id, postId: "post_demo_05", kind: "saved", collectedAt: "2026-07-18T18:00:00.000Z", source: "demo" });
  addCollection(db, { accountId: account.id, postId: "post_demo_01", kind: "liked", collectedAt: "2026-07-24T19:00:00.000Z", source: "demo" });
  addCollection(db, { accountId: account.id, postId: "post_demo_06", kind: "liked", collectedAt: "2026-07-15T12:00:00.000Z", source: "demo" });

  const demoAnalysis = [
    ["post_demo_01", "Rows of handmade ceramic glaze tests in a softly lit studio.", ["#6f8f99", "#d8d2bf", "#806b5d"], ["ceramic", "pottery", "glaze", "studio", "material"], { mood: "quiet", lighting: "soft", palette: "cool", composition: "grid", medium: "photograph" }],
    ["post_demo_02", "A red typographic identity system arranged with tide charts and shipping labels.", ["#c75047", "#ece5d6", "#304c63"], ["graphic design", "poster", "paper", "typography", "layout"], { mood: "graphic", lighting: "flat", palette: "warm", composition: "grid", medium: "photograph" }],
    ["post_demo_03", "Warm evening light moves across a minimal plaster interior wall.", ["#d5a269", "#8a6248", "#3f3b45"], ["interior", "wall", "architecture", "light"], { mood: "calm", lighting: "golden hour", palette: "warm", composition: "minimal", medium: "moving image" }],
    ["post_demo_04", "A foggy ferry scene with passengers looking toward the water.", ["#96a5aa", "#d8d6cf", "#4e5a5f"], ["travel", "ferry", "ocean", "people", "fog"], { mood: "documentary", lighting: "overcast", palette: "cool", composition: "landscape", medium: "photograph" }],
    ["post_demo_05", "Five useful objects and wooden furniture arranged in a compact room.", ["#9a7557", "#ded0b8", "#686052"], ["interior", "furniture", "wood", "room", "chair", "lamp"], { mood: "warm", lighting: "natural", palette: "brown", composition: "editorial", medium: "photograph" }],
    ["post_demo_06", "A print journal issue about repair, care, and material evidence.", ["#e7dfcf", "#292927", "#b66e55"], ["book", "paper", "print", "graphic design", "material"], { mood: "editorial", lighting: "soft", palette: "neutral", composition: "still life", medium: "photograph" }],
    ["post_demo_07", "A morning flower stem study against a pale background.", ["#708b68", "#e6dfd0", "#bf9b8c"], ["flower", "plant", "nature", "botanical"], { mood: "gentle", lighting: "morning", palette: "green", composition: "portrait", medium: "moving image" }],
    ["post_demo_08", "A working studio shelf filled with ceramic samples and unfinished objects.", ["#8a6f59", "#aaaeb5", "#d7c9b4"], ["studio", "shelf", "ceramic", "objects", "material"], { mood: "work-in-progress", lighting: "natural", palette: "neutral", composition: "shelf", medium: "photograph" }],
  ];
  const insertAnalysis = db.prepare(`
    insert into media_analysis(
      media_id, post_id, status, provider, description, ocr_text, colors_json,
      objects_json, style_json, embedding_json, perceptual_hash, attempts,
      queued_at, started_at, completed_at, updated_at
    ) values (?, ?, 'completed', 'local', ?, '', ?, ?, ?, '[]', ?, 1, ?, ?, ?, ?)
  `);
  for (const [postId, description, colors, objects, style] of demoAnalysis) {
    const time = "2026-07-25T17:00:00.000Z";
    insertAnalysis.run(
      `media_${postId}`,
      postId,
      description,
      json(colors, []),
      json(objects, []),
      json(style, {}),
      stableId("fingerprint", postId).slice(-16),
      time,
      time,
      time,
      time,
    );
  }

  const collectionTime = "2026-07-25T17:05:00.000Z";
  const demoCollections = [
    ["collection_demo_graphic", "Graphic design", "graphic-design", "#ff725e", ["post_demo_02"]],
    ["collection_demo_interiors", "Interiors", "interiors", "#d39b6a", ["post_demo_05"]],
  ];
  const insertSmartCollection = db.prepare(`
    insert into library_collections(
      id, account_id, name, slug, description, color, kind, rules_json, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, 'automatic', '{}', ?, ?)
  `);
  const insertSmartItem = db.prepare(`
    insert into library_collection_items(collection_id, post_id, source, added_at)
    values (?, ?, 'automatic', ?)
  `);
  for (const [id, name, slug, color, postIds] of demoCollections) {
    insertSmartCollection.run(id, account.id, name, slug, `${name} found automatically in Saved.`, color, collectionTime, collectionTime);
    for (const postId of postIds) insertSmartItem.run(id, postId, collectionTime);
  }

  db.prepare(`
    insert into boards(id, account_id, name, description, background, created_at, updated_at)
    values ('board_demo_01', ?, 'Issue 09 — material quiet', 'References for a story about useful imperfection.', '#e9e4d9', ?, ?)
  `).run(account.id, collectionTime, collectionTime);
  const insertBoardItem = db.prepare(`
    insert into board_items(
      id, board_id, post_id, media_id, note, x, y, width, height, rotation, sort_order, created_at, updated_at
    ) values (?, 'board_demo_01', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  [
    ["board_item_demo_1", "post_demo_01", "Keep the imperfect tests.", 42, 42, 270, 330, -1.4, 0],
    ["board_item_demo_2", "post_demo_02", "Borrow the red accent and grid.", 352, 76, 290, 345, 1.1, 1],
    ["board_item_demo_3", "post_demo_05", "Warm wood, compact scale.", 690, 38, 270, 330, -0.5, 2],
  ].forEach(([id, postId, note, x, y, width, height, rotation, order]) => {
    insertBoardItem.run(id, postId, `media_${postId}`, note, x, y, width, height, rotation, order, collectionTime, collectionTime);
  });

  upsertComment(db, { id: "comment_demo_1", postId: "post_demo_08", authorProfileId: people[2].id, text: "The unfinished shelf is always the most honest one.", createdAt: "2026-07-12T17:02:00.000Z", source: "demo" });
  upsertComment(db, { id: "comment_demo_2", postId: "post_demo_08", authorProfileId: people[0].id, text: "Would love to see the blue sample closer.", createdAt: "2026-07-12T17:21:00.000Z", source: "demo" });

  const threadRows = [
    ["thread_demo_1", "Nora Singh", people[2], "2026-07-25T16:08:00.000Z", 1],
    ["thread_demo_2", "Paper & Current", people[5], "2026-07-24T19:44:00.000Z", 0],
    ["thread_demo_3", "Linh Tran", people[0], "2026-07-22T09:13:00.000Z", 1],
  ];
  const insertThread = db.prepare(`
    insert into dm_threads(id, account_id, title, last_message_at, unread_count, needs_reply, source, raw_json, updated_at)
    values (?, ?, ?, ?, ?, ?, 'demo', '{}', ?)
  `);
  const insertParticipant = db.prepare("insert into dm_participants(thread_id, profile_id) values (?, ?)");
  const insertMessage = db.prepare(`
    insert into dm_messages(id, thread_id, sender_profile_id, text, created_at, direction, source, raw_json)
    values (?, ?, ?, ?, ?, ?, 'demo', '{}')
  `);
  for (const [threadId, title, person, lastMessageAt, needsReply] of threadRows) {
    insertThread.run(threadId, account.id, title, lastMessageAt, needsReply, needsReply, nowIso());
    insertParticipant.run(threadId, person.id);
  }
  insertMessage.run("dm_demo_1a", "thread_demo_1", people[2].id, "The first layout is strong. Can we make the margins feel a little stranger?", "2026-07-25T16:08:00.000Z", "inbound");
  insertMessage.run("dm_demo_2a", "thread_demo_2", people[5].id, "We saved the studio shelf image for the next issue moodboard.", "2026-07-24T19:44:00.000Z", "inbound");
  insertMessage.run("dm_demo_3a", "thread_demo_3", people[0].id, "Blue sample is celadon over dark stoneware. I’ll send the firing notes.", "2026-07-22T09:13:00.000Z", "inbound");

  recordFollowSnapshot(db, {
    accountId: account.id,
    direction: "followers",
    profileIds: people.map((person) => person.id),
    source: "demo",
    observedAt: "2026-07-25T12:00:00.000Z",
  });
  recordFollowSnapshot(db, {
    accountId: account.id,
    direction: "following",
    profileIds: people.slice(0, 6).map((person) => person.id),
    source: "demo",
    observedAt: "2026-07-25T12:00:00.000Z",
  });
  rebuildFts(db);
  return { seeded: true, accountId: account.id, posts: samples.length, profiles: people.length + 1 };
}
