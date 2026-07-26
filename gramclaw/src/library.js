import { defaultAccount } from "./db.js";
import {
  colorNames,
  cosineSimilarity,
  expandSynonyms,
  parseAnalysisRow,
  textEmbedding,
} from "./analysis.js";
import { nowIso, parseJson, stableId } from "./utils.js";

const TOPICS = [
  { slug: "interiors", name: "Interiors", color: "#d39b6a", words: ["interior", "room", "home", "kitchen", "chair", "table", "lamp", "shelf", "furniture", "wall"] },
  { slug: "ceramics", name: "Ceramics", color: "#86a7a5", words: ["ceramic", "pottery", "clay", "glaze", "stoneware", "vase"] },
  { slug: "graphic-design", name: "Graphic design", color: "#ff725e", words: ["graphic", "poster", "type", "typography", "layout", "paper", "print", "identity", "design"] },
  { slug: "architecture", name: "Architecture", color: "#888b95", words: ["architecture", "building", "house", "facade", "concrete", "brick", "door", "window"] },
  { slug: "nature", name: "Nature", color: "#70a56f", words: ["nature", "flower", "plant", "garden", "ocean", "coast", "beach", "mountain", "landscape"] },
  { slug: "fashion", name: "Fashion", color: "#b780ae", words: ["fashion", "clothing", "outfit", "textile", "jewelry", "style"] },
  { slug: "travel", name: "Travel", color: "#6c9ed6", words: ["travel", "hotel", "city", "restaurant", "street", "ferry", "trip"] },
  { slug: "art", name: "Art", color: "#8267f5", words: ["art", "painting", "sculpture", "gallery", "museum", "studio", "portrait"] },
];

const STOP_WORDS = new Set([
  "a", "all", "and", "are", "by", "find", "for", "from", "i", "in", "is", "it",
  "last", "liked", "me", "media", "my", "of", "on", "or", "photos", "posts",
  "saved", "show", "that", "the", "this", "things", "to", "was", "were", "with", "year",
]);

export function visualSearch(db, query, options = {}) {
  const account = defaultAccount(db);
  const parsed = parseVisualQuery(query, options);
  const conditions = ["posts.deleted_at is null"];
  const params = [account?.id ?? "", account?.id ?? ""];
  if (parsed.saved) conditions.push("exists(select 1 from collections c where c.post_id=posts.id and c.kind='saved')");
  if (parsed.liked) conditions.push("exists(select 1 from collections c where c.post_id=posts.id and c.kind='liked')");
  if (parsed.since) {
    conditions.push("posts.created_at>=?");
    params.push(parsed.since);
  }
  if (parsed.until) {
    conditions.push("posts.created_at<=?");
    params.push(parsed.until);
  }
  if (parsed.author) {
    conditions.push("profiles.username=?");
    params.push(parsed.author);
  }
  if (parsed.kind?.length) {
    conditions.push(`posts.kind in (${parsed.kind.map(() => "?").join(",")})`);
    params.push(...parsed.kind);
  }
  if (parsed.collectionId) {
    conditions.push("exists(select 1 from library_collection_items lci where lci.post_id=posts.id and lci.collection_id=?)");
    params.push(parsed.collectionId);
  }
  if (parsed.unorganized) {
    conditions.push("not exists(select 1 from library_collection_items lci where lci.post_id=posts.id)");
    conditions.push("not exists(select 1 from post_tags where post_tags.post_id=posts.id)");
  }
  const rows = db.prepare(`
    select
      posts.*,
      profiles.username as author_username,
      profiles.display_name as author_display_name,
      profiles.avatar_url as author_avatar_url,
      exists(select 1 from collections c where c.account_id=? and c.post_id=posts.id and c.kind='liked') as liked,
      exists(select 1 from collections c where c.account_id=? and c.post_id=posts.id and c.kind='saved') as saved,
      media.id as media_id,
      media.media_type,
      media.local_path,
      media.remote_url,
      media.thumbnail_url,
      media.width as media_width,
      media.height as media_height,
      media.alt_text as media_alt_text,
      media_analysis.status as analysis_status,
      media_analysis.provider as analysis_provider,
      media_analysis.description as analysis_description,
      media_analysis.ocr_text,
      media_analysis.colors_json,
      media_analysis.objects_json,
      media_analysis.style_json,
      media_analysis.embedding_json,
      media_analysis.perceptual_hash
    from posts
    join profiles on profiles.id=posts.author_profile_id
    left join media on media.id=(
      select m.id from media m where m.post_id=posts.id
      order by coalesce(m.created_at, ''), m.id limit 1
    )
    left join media_analysis on media_analysis.media_id=media.id and media_analysis.status='completed'
    where ${conditions.join(" and ")}
    order by coalesce(posts.created_at, '') desc
    limit 1200
  `).all(...params);

  const queryVector = textEmbedding(parsed.semanticText);
  const queryTokens = tokenize(expandSynonyms(parsed.semanticText)).filter((token) => !STOP_WORDS.has(token));
  const results = [];
  for (const row of rows) {
    const analysis = parseAnalysisRow({
      colors_json: row.colors_json,
      objects_json: row.objects_json,
      style_json: row.style_json,
      embedding_json: row.embedding_json,
    });
    const corpusParts = [
      row.caption,
      row.alt_text,
      row.media_alt_text,
      row.analysis_description,
      row.ocr_text,
      analysis.objects.join(" "),
      Object.values(analysis.style).join(" "),
      row.author_username,
    ];
    const corpus = expandSynonyms(corpusParts.join(" ")).toLowerCase();
    const lexicalMatches = queryTokens.filter((token) => corpus.includes(token));
    const semantic = cosineSimilarity(queryVector, analysis.embedding?.length ? analysis.embedding : textEmbedding(corpus));
    const names = colorNames(analysis.colors);
    const colorMatch = parsed.color ? names.includes(parsed.color) : false;
    if (parsed.color && !colorMatch) continue;
    if (parsed.topic && !corpus.includes(parsed.topic.toLowerCase())) continue;

    let score = 0;
    score += lexicalMatches.length * 14;
    score += Math.max(0, semantic) * 42;
    if (colorMatch) score += 30;
    if (parsed.saved && row.saved) score += 4;
    if (parsed.liked && row.liked) score += 4;
    if (!queryTokens.length && !parsed.color) score = 1;
    if (queryTokens.length && score < 3) continue;

    const why = [];
    const captionMatches = queryTokens.filter((token) => String(row.caption ?? "").toLowerCase().includes(token));
    const ocrMatches = queryTokens.filter((token) => String(row.ocr_text ?? "").toLowerCase().includes(token));
    const objectMatches = queryTokens.filter((token) => analysis.objects.some((object) => object.includes(token)));
    if (captionMatches.length) why.push(`Caption: ${unique(captionMatches).slice(0, 3).join(", ")}`);
    if (ocrMatches.length) why.push(`Text in image: ${unique(ocrMatches).slice(0, 3).join(", ")}`);
    if (objectMatches.length) why.push(`Objects: ${unique(objectMatches).slice(0, 3).join(", ")}`);
    if (colorMatch) why.push(`${capitalize(parsed.color)} palette`);
    if (semantic > 0.16) why.push("Similar visual concepts");
    if (!why.length && row.analysis_description) why.push("Matched its visual description");
    if (parsed.saved) why.push("Saved item");
    if (parsed.liked) why.push("Liked item");

    results.push({
      ...row,
      liked: Boolean(row.liked),
      saved: Boolean(row.saved),
      media: row.media_id ? [{
        id: row.media_id,
        media_type: row.media_type,
        local_path: row.local_path,
        remote_url: row.remote_url,
        thumbnail_url: row.thumbnail_url,
        width: row.media_width,
        height: row.media_height,
        alt_text: row.media_alt_text,
      }] : [],
      analysis: {
        status: row.analysis_status,
        provider: row.analysis_provider,
        description: row.analysis_description ?? "",
        ocrText: row.ocr_text ?? "",
        colors: analysis.colors,
        objects: analysis.objects,
        style: analysis.style,
      },
      score: Math.round(score),
      why: unique(why).slice(0, 4),
    });
  }
  results.sort((left, right) => right.score - left.score || String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")));
  return {
    q: query,
    interpretedAs: parsed,
    items: results.slice(0, Math.max(1, Math.min(200, Number(options.limit ?? 80)))),
  };
}

export function parseVisualQuery(query, options = {}) {
  const raw = String(query ?? "").trim();
  const lower = raw.toLowerCase();
  const current = new Date();
  const result = {
    saved: asOptionalBoolean(options.saved) ?? /\b(saved|bookmarked)\b/.test(lower),
    liked: asOptionalBoolean(options.liked) ?? /\b(liked|hearts?)\b/.test(lower),
    since: options.since || null,
    until: options.until || null,
    author: options.author ? normalizeAuthor(options.author) : null,
    color: options.color?.toLowerCase() || findColor(lower),
    topic: options.topic || null,
    collectionId: options.collectionId || null,
    unorganized: asOptionalBoolean(options.unorganized) ?? false,
    kind: options.kind ? normalizeKinds(options.kind) : inferKinds(lower),
    semanticText: raw,
  };
  if (!result.since && !result.until && /\blast year\b/.test(lower)) {
    const year = current.getFullYear() - 1;
    result.since = `${year}-01-01T00:00:00.000Z`;
    result.until = `${year}-12-31T23:59:59.999Z`;
  } else if (!result.since && !result.until && /\bthis year\b/.test(lower)) {
    result.since = `${current.getFullYear()}-01-01T00:00:00.000Z`;
  } else if (!result.since) {
    const recent = lower.match(/\blast\s+(\d+)\s+(day|week|month|year)s?\b/);
    if (recent) {
      const date = new Date(current);
      const count = Number(recent[1]);
      if (recent[2] === "day") date.setDate(date.getDate() - count);
      if (recent[2] === "week") date.setDate(date.getDate() - count * 7);
      if (recent[2] === "month") date.setMonth(date.getMonth() - count);
      if (recent[2] === "year") date.setFullYear(date.getFullYear() - count);
      result.since = date.toISOString();
    }
  }
  const explicitYear = lower.match(/\b(?:in|from)\s+(20\d{2})\b/);
  if (explicitYear && !options.since && !options.until) {
    result.since = `${explicitYear[1]}-01-01T00:00:00.000Z`;
    result.until = `${explicitYear[1]}-12-31T23:59:59.999Z`;
  }
  const authorMatch = lower.match(/\b(?:from|by)\s+@?([a-z0-9._]{2,})\b/);
  if (!result.author && authorMatch && !/^20\d{2}$/.test(authorMatch[1])) result.author = authorMatch[1];
  return result;
}

export function organizeLibrary(db) {
  const account = defaultAccount(db);
  if (!account) return { ok: true, collections: 0, organized: 0, unorganized: 0 };
  const saved = visualSearch(db, "", { saved: true, limit: 1000 }).items;
  const time = nowIso();
  const upsertCollection = db.prepare(`
    insert into library_collections(id, account_id, name, slug, description, color, kind, rules_json, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, 'automatic', ?, ?, ?)
    on conflict(account_id, slug) do update set
      name=excluded.name,
      description=excluded.description,
      color=excluded.color,
      rules_json=excluded.rules_json,
      updated_at=excluded.updated_at
  `);
  const lookup = db.prepare("select id from library_collections where account_id=? and slug=?");
  const addItem = db.prepare(`
    insert into library_collection_items(collection_id, post_id, source, added_at)
    values (?, ?, 'automatic', ?)
    on conflict(collection_id, post_id) do update set source='automatic'
  `);
  const rebuild = db.transaction(() => {
    db.prepare(`
      delete from library_collection_items
      where source='automatic' and collection_id in (
        select id from library_collections where account_id=? and kind='automatic'
      )
    `).run(account.id);
    for (const topic of TOPICS) {
      const id = stableId("collection", account.id, topic.slug);
      upsertCollection.run(
        id,
        account.id,
        topic.name,
        topic.slug,
        `${topic.name} found automatically in your Saved library.`,
        topic.color,
        JSON.stringify({ words: topic.words }),
        time,
        time,
      );
      const collectionId = lookup.get(account.id, topic.slug)?.id ?? id;
      for (const item of saved) {
        const corpus = [
          item.caption,
          item.analysis?.description,
          item.analysis?.objects?.join(" "),
          Object.values(item.analysis?.style ?? {}).join(" "),
        ].join(" ").toLowerCase();
        if (topic.words.some((word) => corpus.includes(word))) addItem.run(collectionId, item.id, time);
      }
    }
  });
  rebuild();
  const overview = getLibraryOverview(db);
  return {
    ok: true,
    collections: overview.collections.filter((item) => item.kind === "automatic" && item.count > 0).length,
    organized: overview.savedCount - overview.unorganizedCount,
    unorganized: overview.unorganizedCount,
  };
}

export function getLibraryOverview(db) {
  const account = defaultAccount(db);
  const accountId = account?.id ?? "";
  const collections = db.prepare(`
    select
      library_collections.*,
      count(library_collection_items.post_id) as count,
      (
        select media.id from library_collection_items cover_items
        join media on media.post_id=cover_items.post_id
        where cover_items.collection_id=library_collections.id
        order by cover_items.added_at desc limit 1
      ) as cover_media_id
    from library_collections
    left join library_collection_items on library_collection_items.collection_id=library_collections.id
    where library_collections.account_id=?
    group by library_collections.id
    order by library_collections.kind desc, count desc, library_collections.name
  `).all(accountId).map((row) => ({ ...row, rules: parseJson(row.rules_json, {}), count: Number(row.count) }));
  const tags = db.prepare(`
    select tags.*, count(post_tags.post_id) as count
    from tags left join post_tags on post_tags.tag_id=tags.id
    where tags.account_id=?
    group by tags.id order by count desc, tags.name
  `).all(accountId).map((row) => ({ ...row, count: Number(row.count) }));
  const savedCount = Number(db.prepare("select count(*) as count from collections where account_id=? and kind='saved'").get(accountId)?.count ?? 0);
  const unorganizedCount = Number(db.prepare(`
    select count(*) as count
    from collections
    where account_id=? and kind='saved'
      and not exists(select 1 from library_collection_items where library_collection_items.post_id=collections.post_id)
      and not exists(select 1 from post_tags where post_tags.post_id=collections.post_id)
  `).get(accountId)?.count ?? 0);
  return {
    collections,
    tags,
    savedCount,
    unorganizedCount,
    duplicates: listDuplicateGroups(db).length,
  };
}

export function createLibraryCollection(db, input = {}) {
  const account = defaultAccount(db);
  if (!account) throw new Error("Import or initialize an account first.");
  const name = String(input.name ?? "").trim().slice(0, 80);
  if (!name) throw new Error("Collection name is required.");
  const slug = slugify(name);
  const time = nowIso();
  const id = stableId("collection", account.id, slug);
  db.prepare(`
    insert into library_collections(id, account_id, name, slug, description, color, kind, rules_json, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, 'custom', '{}', ?, ?)
    on conflict(account_id, slug) do update set
      name=excluded.name,
      description=excluded.description,
      color=excluded.color,
      updated_at=excluded.updated_at
  `).run(id, account.id, name, slug, String(input.description ?? "").slice(0, 500), safeColor(input.color, "#8267f5"), time, time);
  const collection = db.prepare("select * from library_collections where account_id=? and slug=?").get(account.id, slug);
  if (input.postIds?.length) addPostsToCollection(db, collection.id, input.postIds);
  return collection;
}

export function addPostsToCollection(db, collectionId, postIds = []) {
  const time = nowIso();
  const statement = db.prepare(`
    insert into library_collection_items(collection_id, post_id, source, added_at)
    values (?, ?, 'manual', ?)
    on conflict(collection_id, post_id) do update set source='manual'
  `);
  const run = db.transaction((items) => {
    for (const postId of items) statement.run(collectionId, postId, time);
  });
  run(unique(postIds));
  return { ok: true, added: unique(postIds).length };
}

export function removePostsFromCollection(db, collectionId, postIds = []) {
  const statement = db.prepare("delete from library_collection_items where collection_id=? and post_id=?");
  const run = db.transaction((items) => {
    for (const postId of items) statement.run(collectionId, postId);
  });
  run(unique(postIds));
  return { ok: true, removed: unique(postIds).length };
}

export function createTag(db, input = {}) {
  const account = defaultAccount(db);
  if (!account) throw new Error("Import or initialize an account first.");
  const name = String(input.name ?? "").trim().slice(0, 48);
  if (!name) throw new Error("Tag name is required.");
  const slug = slugify(name);
  const id = stableId("tag", account.id, slug);
  db.prepare(`
    insert into tags(id, account_id, name, slug, color, created_at)
    values (?, ?, ?, ?, ?, ?)
    on conflict(account_id, slug) do update set name=excluded.name, color=excluded.color
  `).run(id, account.id, name, slug, safeColor(input.color, "#d8f75a"), nowIso());
  const tag = db.prepare("select * from tags where account_id=? and slug=?").get(account.id, slug);
  if (input.postIds?.length) tagPosts(db, tag.id, input.postIds);
  return tag;
}

export function tagPosts(db, tagId, postIds = []) {
  const statement = db.prepare(`
    insert into post_tags(post_id, tag_id, added_at) values (?, ?, ?)
    on conflict(post_id, tag_id) do nothing
  `);
  const time = nowIso();
  const run = db.transaction((items) => {
    for (const postId of items) statement.run(postId, tagId, time);
  });
  run(unique(postIds));
  return { ok: true, tagged: unique(postIds).length };
}

export function listDuplicateGroups(db) {
  const groups = db.prepare(`
    select perceptual_hash, count(distinct post_id) as count
    from media_analysis
    where status='completed' and perceptual_hash is not null and perceptual_hash<>''
    group by perceptual_hash
    having count(distinct post_id)>1
    order by count desc
  `).all();
  return groups.map((group) => ({
    hash: group.perceptual_hash,
    items: visualSearch(db, "", { limit: 1000 }).items.filter((item) => item.perceptual_hash === group.perceptual_hash),
  }));
}

export function listBoards(db) {
  const account = defaultAccount(db);
  return db.prepare(`
    select
      boards.*,
      count(board_items.id) as item_count,
      (select media_id from board_items where board_id=boards.id order by sort_order limit 1) as cover_media_id
    from boards left join board_items on board_items.board_id=boards.id
    where boards.account_id=?
    group by boards.id order by boards.updated_at desc
  `).all(account?.id ?? "").map((row) => ({ ...row, item_count: Number(row.item_count) }));
}

export function createBoard(db, input = {}) {
  const account = defaultAccount(db);
  if (!account) throw new Error("Import or initialize an account first.");
  const name = String(input.name ?? "").trim().slice(0, 80);
  if (!name) throw new Error("Board name is required.");
  const id = stableId("board", account.id, name, Date.now(), Math.random());
  const time = nowIso();
  db.prepare(`
    insert into boards(id, account_id, name, description, background, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?)
  `).run(id, account.id, name, String(input.description ?? "").slice(0, 500), safeColor(input.background, "#f1efe9"), time, time);
  if (input.postIds?.length) addBoardItems(db, id, input.postIds);
  return getBoard(db, id);
}

export function getBoard(db, boardId) {
  const board = db.prepare("select * from boards where id=?").get(boardId);
  if (!board) return null;
  board.items = db.prepare(`
    select
      board_items.*,
      posts.caption,
      posts.kind,
      posts.created_at as post_created_at,
      profiles.username as author_username,
      media.media_type,
      media.local_path,
      media.remote_url,
      media.thumbnail_url,
      media.alt_text
    from board_items
    join posts on posts.id=board_items.post_id
    join profiles on profiles.id=posts.author_profile_id
    left join media on media.id=coalesce(
      board_items.media_id,
      (select id from media where media.post_id=posts.id order by coalesce(created_at, ''), id limit 1)
    )
    where board_items.board_id=?
    order by board_items.sort_order, board_items.created_at
  `).all(boardId);
  return board;
}

export function addBoardItems(db, boardId, postIds = []) {
  const board = db.prepare("select id from boards where id=?").get(boardId);
  if (!board) throw new Error("Board not found.");
  const current = Number(db.prepare("select coalesce(max(sort_order), -1) as value from board_items where board_id=?").get(boardId).value);
  const time = nowIso();
  const insert = db.prepare(`
    insert into board_items(
      id, board_id, post_id, media_id, note, x, y, width, height, rotation, sort_order, created_at, updated_at
    ) values (?, ?, ?, ?, '', ?, ?, 260, 320, ?, ?, ?, ?)
    on conflict(id) do nothing
  `);
  const uniqueIds = unique(postIds);
  const run = db.transaction((items) => {
    items.forEach((postId, index) => {
      const media = db.prepare("select id from media where post_id=? order by coalesce(created_at, ''), id limit 1").get(postId);
      const column = index % 3;
      const row = Math.floor(index / 3);
      insert.run(
        stableId("board_item", boardId, postId),
        boardId,
        postId,
        media?.id ?? null,
        32 + column * 300,
        36 + row * 360,
        ((index % 5) - 2) * 0.8,
        current + index + 1,
        time,
        time,
      );
    });
    db.prepare("update boards set updated_at=? where id=?").run(time, boardId);
  });
  run(uniqueIds);
  return getBoard(db, boardId);
}

export function updateBoard(db, boardId, input = {}) {
  const board = db.prepare("select * from boards where id=?").get(boardId);
  if (!board) throw new Error("Board not found.");
  db.prepare(`
    update boards set name=?, description=?, background=?, updated_at=? where id=?
  `).run(
    String(input.name ?? board.name).trim().slice(0, 80) || board.name,
    String(input.description ?? board.description).slice(0, 500),
    safeColor(input.background, board.background),
    nowIso(),
    boardId,
  );
  return getBoard(db, boardId);
}

export function updateBoardItem(db, boardId, itemId, input = {}) {
  const item = db.prepare("select * from board_items where id=? and board_id=?").get(itemId, boardId);
  if (!item) throw new Error("Board item not found.");
  db.prepare(`
    update board_items
    set note=?, x=?, y=?, width=?, height=?, rotation=?, sort_order=?, updated_at=?
    where id=? and board_id=?
  `).run(
    String(input.note ?? item.note).slice(0, 1000),
    finite(input.x, item.x),
    finite(input.y, item.y),
    clamp(finite(input.width, item.width), 140, 720),
    clamp(finite(input.height, item.height), 160, 820),
    clamp(finite(input.rotation, item.rotation), -15, 15),
    Math.round(finite(input.sortOrder, item.sort_order)),
    nowIso(),
    itemId,
    boardId,
  );
  db.prepare("update boards set updated_at=? where id=?").run(nowIso(), boardId);
  return db.prepare("select * from board_items where id=?").get(itemId);
}

export function removeBoardItem(db, boardId, itemId) {
  const result = db.prepare("delete from board_items where id=? and board_id=?").run(itemId, boardId);
  db.prepare("update boards set updated_at=? where id=?").run(nowIso(), boardId);
  return { ok: true, removed: result.changes };
}

function normalizeKinds(value) {
  const values = Array.isArray(value) ? value : String(value).split(",");
  return unique(values.map((item) => item.trim().toLowerCase()).filter((item) => ["post", "carousel", "reel", "story", "archived", "placeholder"].includes(item)));
}

function inferKinds(lower) {
  const kinds = [];
  if (/\b(reel|video|videos)\b/.test(lower)) kinds.push("reel");
  if (/\bstor(y|ies)\b/.test(lower)) kinds.push("story");
  if (/\bcarousel(s)?\b/.test(lower)) kinds.push("carousel");
  if (/\b(photo|photos|image|images|post|posts)\b/.test(lower)) kinds.push("post", "carousel");
  return unique(kinds);
}

function findColor(lower) {
  return Object.keys({
    black: 1, blue: 1, brown: 1, cream: 1, green: 1, grey: 1, gray: 1,
    orange: 1, pink: 1, purple: 1, red: 1, tan: 1, white: 1, yellow: 1,
  }).find((color) => new RegExp(`\\b${color}\\b`).test(lower)) ?? null;
}

function normalizeAuthor(value) {
  return String(value ?? "").trim().replace(/^@/, "").toLowerCase();
}

function tokenize(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function slugify(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "collection";
}

function safeColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value ?? "")) ? String(value) : fallback;
}

function asOptionalBoolean(value) {
  if (value === undefined || value === null || value === "") return null;
  return value === true || value === 1 || value === "1" || value === "true";
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number(fallback);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function capitalize(value) {
  const string = String(value ?? "");
  return string ? string[0].toUpperCase() + string.slice(1) : "";
}
