import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ensureDirs } from "./config.js";
import { getDb } from "./db.js";
import { nowIso, parseJson } from "./utils.js";

const execFileAsync = promisify(execFile);
const MACOS_VISION = fileURLToPath(new URL("../native/macos-vision.swift", import.meta.url));
const workers = new WeakMap();
let macosVisionBinaryPromise;

const COLOR_NAMES = {
  black: "#171717",
  blue: "#4f79c7",
  brown: "#8b6547",
  cream: "#eee4cc",
  green: "#5e8a5f",
  grey: "#888888",
  gray: "#888888",
  orange: "#d98545",
  pink: "#d98ca2",
  purple: "#8068b7",
  red: "#c95852",
  tan: "#c2a67d",
  white: "#f3f1eb",
  yellow: "#d6bb42",
};

const OBJECT_WORDS = new Set([
  "architecture", "art", "bathroom", "beach", "book", "ceramic", "chair", "city",
  "clothing", "coffee", "desk", "design", "door", "flower", "food", "furniture",
  "garden", "glass", "home", "hotel", "house", "interior", "jewelry", "kitchen",
  "lamp", "landscape", "light", "material", "mountain", "nature", "ocean", "painting",
  "paper", "plant", "portrait", "poster", "pottery", "restaurant", "room", "shelf",
  "studio", "table", "textile", "travel", "vase", "wall", "wood",
]);

export function enqueueAnalysis(db, options = {}) {
  const provider = options.provider === "cloud" ? "cloud" : "local";
  const conditions = ["media.post_id is not null"];
  const params = [];
  if (options.postIds?.length) {
    conditions.push(`media.post_id in (${options.postIds.map(() => "?").join(",")})`);
    params.push(...options.postIds);
  }
  if (!options.force) {
    conditions.push("not exists(select 1 from media_analysis ma where ma.media_id=media.id and ma.status='completed' and ma.provider=?)");
    params.push(provider);
  }
  const limit = Math.max(1, Math.min(10_000, Number(options.limit ?? 500)));
  params.push(limit);
  const rows = db.prepare(`
    select media.id, media.post_id
    from media
    where ${conditions.join(" and ")}
    order by coalesce(media.created_at, ''), media.id
    limit ?
  `).all(...params);
  const time = nowIso();
  const statement = db.prepare(`
    insert into media_analysis(
      media_id, post_id, status, provider, queued_at, updated_at
    ) values (?, ?, 'queued', ?, ?, ?)
    on conflict(media_id) do update set
      post_id=excluded.post_id,
      status='queued',
      provider=excluded.provider,
      error=null,
      queued_at=excluded.queued_at,
      updated_at=excluded.updated_at
  `);
  const insert = db.transaction((items) => {
    for (const row of items) statement.run(row.id, row.post_id, provider, time, time);
  });
  insert(rows);
  return { queued: rows.length, provider };
}

export function retryFailedAnalysis(db, options = {}) {
  const provider = options.provider === "cloud" ? "cloud" : "local";
  const result = db.prepare(`
    update media_analysis
    set status='queued', provider=?, error=null, queued_at=?, updated_at=?
    where status='failed'
  `).run(provider, nowIso(), nowIso());
  return { queued: result.changes, provider };
}

export function startAnalysis(options = {}) {
  const db = options.db ?? getDb();
  const queued = enqueueAnalysis(db, options);
  if (!workers.get(db)) {
    const worker = processQueue(db)
      .catch(() => {})
      .finally(() => workers.delete(db));
    workers.set(db, worker);
  }
  return { ok: true, ...queued, status: getAnalysisStatus(db) };
}

export async function runAnalysis(options = {}) {
  const db = options.db ?? getDb();
  const result = startAnalysis({ ...options, db });
  await workers.get(db);
  return { ...result, status: getAnalysisStatus(db) };
}

export function resumeAnalysis(options = {}) {
  const db = options.db ?? getDb();
  if (!workers.get(db) && db.prepare("select 1 from media_analysis where status='queued' limit 1").get()) {
    const worker = processQueue(db)
      .catch(() => {})
      .finally(() => workers.delete(db));
    workers.set(db, worker);
  }
  return getAnalysisStatus(db);
}

export function getAnalysisStatus(db = getDb()) {
  const counts = { queued: 0, running: 0, completed: 0, failed: 0 };
  for (const row of db.prepare("select status, count(*) as count from media_analysis group by status").all()) {
    counts[row.status] = Number(row.count);
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const finished = counts.completed + counts.failed;
  const latest = db.prepare(`
    select media_id, post_id, status, provider, error, updated_at
    from media_analysis order by updated_at desc limit 1
  `).get() ?? null;
  return {
    active: Boolean(workers.get(db)) || counts.queued > 0 || counts.running > 0,
    counts,
    total,
    progress: total ? Math.round((finished / total) * 100) : 0,
    latest,
    cloudAvailable: Boolean(process.env.OPENAI_API_KEY),
    localEngine: process.platform === "darwin" ? "Apple Vision + private local index" : "private local metadata index",
  };
}

async function processQueue(db) {
  db.prepare("update media_analysis set status='queued', updated_at=? where status='running'").run(nowIso());
  while (true) {
    const job = db.prepare(`
      select
        media_analysis.*,
        media.local_path,
        media.remote_url,
        media.media_type,
        media.width,
        media.height,
        media.alt_text as media_alt_text,
        posts.caption,
        posts.alt_text as post_alt_text,
        posts.created_at,
        profiles.username as author_username
      from media_analysis
      join media on media.id=media_analysis.media_id
      left join posts on posts.id=media_analysis.post_id
      left join profiles on profiles.id=posts.author_profile_id
      where media_analysis.status='queued'
      order by media_analysis.queued_at, media_analysis.media_id
      limit 1
    `).get();
    if (!job) break;
    db.prepare(`
      update media_analysis
      set status='running', attempts=attempts+1, started_at=?, error=null, updated_at=?
      where media_id=?
    `).run(nowIso(), nowIso(), job.media_id);
    try {
      const local = await analyzeLocal(job);
      const result = job.provider === "cloud" ? await analyzeCloud(job, local) : local;
      saveAnalysis(db, job, result);
    } catch (error) {
      db.prepare(`
        update media_analysis
        set status='failed', error=?, completed_at=?, updated_at=?
        where media_id=?
      `).run(error instanceof Error ? error.message : String(error), nowIso(), nowIso(), job.media_id);
    }
  }
}

async function analyzeLocal(job) {
  const sourceText = [job.media_alt_text, job.post_alt_text, job.caption]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(". ");
  let native = { ocrText: "", labels: [], colors: [] };
  if (
    process.platform === "darwin"
    && job.media_type === "image"
    && job.local_path
    && existsSync(job.local_path)
    && existsSync(MACOS_VISION)
  ) {
    try {
      const binary = await macosVisionBinary();
      const { stdout } = await execFileAsync(binary, [job.local_path], {
        timeout: 120_000,
        maxBuffer: 2_000_000,
      });
      native = JSON.parse(stdout);
    } catch {
      // Metadata analysis remains available if Apple Vision cannot read this file.
    }
  }
  const colors = native.colors?.length ? native.colors : paletteFromText(sourceText || job.media_id);
  const objects = unique([
    ...(native.labels ?? []).flatMap((label) => String(label).split(/[,/]/)),
    ...extractObjects(sourceText),
  ]).slice(0, 16);
  const description = firstSentence(job.media_alt_text)
    || firstSentence(job.post_alt_text)
    || firstSentence(job.caption)
    || `${job.media_type === "video" ? "Video" : "Image"} from @${job.author_username || "unknown"}`;
  const style = inferStyle({ colors, sourceText, width: job.width, height: job.height, mediaType: job.media_type });
  const semanticText = [
    description,
    native.ocrText,
    objects.join(" "),
    Object.values(style).join(" "),
    colorNames(colors).join(" "),
  ].join(" ");
  return {
    description,
    ocrText: native.ocrText ?? "",
    colors,
    objects,
    style,
    embedding: textEmbedding(semanticText),
    perceptualHash: fileHash(job.local_path) ?? createHash("sha256").update(semanticText).digest("hex").slice(0, 16),
  };
}

async function macosVisionBinary() {
  const binary = join(ensureDirs().rootDir, "macos-vision");
  if (
    existsSync(binary)
    && statSync(binary).mtimeMs >= statSync(MACOS_VISION).mtimeMs
  ) return binary;
  macosVisionBinaryPromise ??= execFileAsync("swiftc", [MACOS_VISION, "-o", binary], {
    timeout: 120_000,
    maxBuffer: 2_000_000,
  }).then(() => {
    chmodSync(binary, 0o700);
    return binary;
  }).finally(() => {
    macosVisionBinaryPromise = undefined;
  });
  return macosVisionBinaryPromise;
}

async function analyzeCloud(job, local) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Cloud analysis requires OPENAI_API_KEY. Local analysis never needs a key.");
  const imageUrl = imageInput(job);
  if (!imageUrl) throw new Error("Cloud analysis needs a cached image or a usable media URL.");
  const prompt = `Analyze this Instagram image for a private visual library.
Return one JSON object only with these exact keys:
description (one precise sentence), ocrText (all readable text), colors (3-6 hex colors),
objects (5-16 concise nouns), and style (an object with mood, lighting, composition, medium, era).
Do not infer identities or sensitive traits. Existing caption: ${JSON.stringify(job.caption ?? "")}`;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.GRAMCLAW_OPENAI_VISION_MODEL || "gpt-5.6-luna",
      reasoning: { effort: "none" },
      store: false,
      max_output_tokens: 900,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: imageUrl, detail: "low" },
        ],
      }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `Cloud analysis failed (${response.status}).`);
  const outputText = (payload.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text)
    .join("");
  const parsed = parseModelJson(outputText);
  const colors = Array.isArray(parsed.colors) && parsed.colors.length ? parsed.colors : local.colors;
  const objects = unique([...(parsed.objects ?? []), ...local.objects]).slice(0, 20);
  const style = { ...local.style, ...(parsed.style ?? {}) };
  const description = String(parsed.description || local.description);
  const ocrText = String(parsed.ocrText || parsed.ocr_text || local.ocrText || "");
  return {
    ...local,
    description,
    ocrText,
    colors,
    objects,
    style,
    embedding: textEmbedding([
      description,
      ocrText,
      objects.join(" "),
      Object.values(style).join(" "),
      colorNames(colors).join(" "),
    ].join(" ")),
  };
}

function saveAnalysis(db, job, result) {
  const completed = nowIso();
  const commit = db.transaction(() => {
    db.prepare(`
      update media_analysis set
        status='completed',
        description=?,
        ocr_text=?,
        colors_json=?,
        objects_json=?,
        style_json=?,
        embedding_json=?,
        perceptual_hash=?,
        error=null,
        completed_at=?,
        updated_at=?
      where media_id=?
    `).run(
      result.description,
      result.ocrText,
      JSON.stringify(result.colors),
      JSON.stringify(result.objects),
      JSON.stringify(result.style),
      JSON.stringify(result.embedding),
      result.perceptualHash,
      completed,
      completed,
      job.media_id,
    );
    db.prepare("delete from visual_fts where media_id=?").run(job.media_id);
    db.prepare(`
      insert into visual_fts(media_id, post_id, description, ocr_text, objects, style)
      values (?, ?, ?, ?, ?, ?)
    `).run(
      job.media_id,
      job.post_id,
      result.description,
      result.ocrText,
      result.objects.join(" "),
      Object.values(result.style).join(" "),
    );
  });
  commit();
}

function imageInput(job) {
  if (job.local_path && existsSync(job.local_path)) {
    const extension = extname(job.local_path).toLowerCase();
    const mime = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
      ".gif": "image/gif",
    }[extension];
    if (!mime) return null;
    return `data:${mime};base64,${readFileSync(job.local_path).toString("base64")}`;
  }
  return /^https:\/\//i.test(job.remote_url ?? "") ? job.remote_url : null;
}

function parseModelJson(text) {
  const cleaned = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Cloud analysis returned an invalid response.");
    return JSON.parse(match[0]);
  }
}

function firstSentence(value) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  return (text.match(/^.*?(?:[.!?](?:\s|$)|$)/)?.[0] ?? text).trim().slice(0, 280);
}

function extractObjects(text) {
  const tokens = tokenize(text);
  return unique(tokens.filter((token) => OBJECT_WORDS.has(token)));
}

function inferStyle({ colors, sourceText, width, height, mediaType }) {
  const rgb = colors.map(hexToRgb).filter(Boolean);
  const avg = rgb.length
    ? rgb.reduce((sum, color) => ({
        r: sum.r + color.r / rgb.length,
        g: sum.g + color.g / rgb.length,
        b: sum.b + color.b / rgb.length,
      }), { r: 0, g: 0, b: 0 })
    : { r: 128, g: 128, b: 128 };
  const brightness = (avg.r * 299 + avg.g * 587 + avg.b * 114) / 255000;
  const warmth = avg.r - avg.b;
  const lower = String(sourceText ?? "").toLowerCase();
  return {
    mood: /quiet|calm|soft|fog|morning/.test(lower) ? "quiet" : brightness > 0.7 ? "bright" : brightness < 0.34 ? "moody" : "balanced",
    lighting: brightness > 0.68 ? "high-key" : brightness < 0.35 ? "low-key" : "natural",
    palette: warmth > 22 ? "warm" : warmth < -18 ? "cool" : "neutral",
    composition: width && height ? (width > height * 1.2 ? "landscape" : height > width * 1.2 ? "portrait" : "square") : "unknown",
    medium: mediaType === "video" ? "moving image" : "photograph",
  };
}

function paletteFromText(value) {
  const digest = createHash("sha256").update(String(value)).digest();
  return [0, 3, 6].map((index) => {
    const red = 48 + digest[index] % 176;
    const green = 48 + digest[index + 1] % 176;
    const blue = 48 + digest[index + 2] % 176;
    return `#${[red, green, blue].map((component) => component.toString(16).padStart(2, "0")).join("")}`;
  });
}

function fileHash(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

export function textEmbedding(value, dimensions = 128) {
  const vector = Array(dimensions).fill(0);
  const tokens = tokenize(expandSynonyms(value));
  for (const token of tokens) {
    const digest = createHash("sha256").update(token).digest();
    for (let index = 0; index < 6; index += 1) {
      const slot = ((digest[index * 2] << 8) | digest[index * 2 + 1]) % dimensions;
      vector[slot] += digest[12 + index] % 2 ? 1 : -1;
    }
  }
  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0)) || 1;
  return vector.map((item) => Number((item / magnitude).toFixed(6)));
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || left.length !== right.length) return 0;
  return left.reduce((sum, value, index) => sum + value * Number(right[index] || 0), 0);
}

export function expandSynonyms(value) {
  const text = String(value ?? "").toLowerCase();
  const groups = [
    ["wooden", "wood", "timber"],
    ["kitchen", "interior", "room", "home"],
    ["ceramic", "pottery", "clay", "glaze"],
    ["flower", "floral", "plant", "botanical"],
    ["sea", "ocean", "coast", "beach"],
    ["minimal", "minimalist", "clean", "quiet"],
    ["fashion", "clothing", "outfit", "style"],
    ["architecture", "building", "house", "interior"],
  ];
  const additions = [];
  for (const group of groups) {
    if (group.some((term) => text.includes(term))) additions.push(...group);
  }
  return `${text} ${additions.join(" ")}`.trim();
}

export function colorNames(colors) {
  const result = [];
  for (const color of colors ?? []) {
    const rgb = hexToRgb(color);
    if (!rgb) continue;
    let best = null;
    let bestDistance = Infinity;
    for (const [name, hex] of Object.entries(COLOR_NAMES)) {
      const candidate = hexToRgb(hex);
      const distance = Math.hypot(rgb.r - candidate.r, rgb.g - candidate.g, rgb.b - candidate.b);
      if (distance < bestDistance) {
        best = name;
        bestDistance = distance;
      }
    }
    if (best) result.push(best);
  }
  return unique(result);
}

export function colorForName(name) {
  return COLOR_NAMES[String(name ?? "").toLowerCase()] ?? null;
}

function hexToRgb(value) {
  const match = String(value ?? "").match(/^#?([0-9a-f]{6})$/i);
  if (!match) return null;
  return {
    r: Number.parseInt(match[1].slice(0, 2), 16),
    g: Number.parseInt(match[1].slice(2, 4), 16),
    b: Number.parseInt(match[1].slice(4, 6), 16),
  };
}

function tokenize(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function unique(values) {
  return [...new Set(values.map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
}

export function parseAnalysisRow(row) {
  if (!row) return row;
  return {
    ...row,
    colors: parseJson(row.colors_json, []),
    objects: parseJson(row.objects_json, []),
    style: parseJson(row.style_json, {}),
    embedding: parseJson(row.embedding_json, []),
  };
}
