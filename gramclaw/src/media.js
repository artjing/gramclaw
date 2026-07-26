import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { ensureDirs } from "./config.js";
import { getDb } from "./db.js";
import { safeFilename } from "./utils.js";

export async function fetchMedia(options = {}) {
  const db = getDb();
  const limit = Math.min(10_000, Number(options.limit ?? 200));
  const conditions = ["remote_url is not null", "remote_url<>''"];
  if (!options.force) conditions.push("(local_path is null or local_path='')");
  if (options.postId) conditions.push("post_id=?");
  const params = options.postId ? [options.postId, limit] : [limit];
  const rows = db.prepare(`
    select * from media
    where ${conditions.join(" and ")}
    order by coalesce(created_at, ''), id
    limit ?
  `).all(...params);
  const concurrency = Math.max(1, Math.min(12, Number(options.concurrency ?? 3)));
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      const row = rows[index];
      try {
        results.push(await downloadOne(db, row, options));
      } catch (error) {
        results.push({
          id: row.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, Number(options.delayMs)));
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return {
    ok: results.every((result) => result.ok),
    requested: rows.length,
    downloaded: results.filter((result) => result.downloaded).length,
    reused: results.filter((result) => result.reused).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
}

async function downloadOne(db, row, options) {
  if (row.local_path && existsSync(row.local_path) && !options.force) {
    return { id: row.id, ok: true, reused: true, path: row.local_path, bytes: statSync(row.local_path).size };
  }
  const response = await fetch(row.remote_url, {
    headers: {
      "user-agent": "Mozilla/5.0 Gramclaw/1.0",
      referer: "https://www.instagram.com/",
    },
    signal: AbortSignal.timeout(Number(options.timeout ?? 60_000)),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for media ${row.id}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get("content-type") ?? "";
  const extension = extensionFor(row.remote_url, type, row.media_type);
  const owner = row.post_id ?? row.dm_message_id ?? "unattached";
  const { mediaOriginalsDir } = ensureDirs();
  const folder = join(mediaOriginalsDir, "live", safeFilename(owner));
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${safeFilename(row.id)}${extension}`);
  writeFileSync(path, bytes);
  db.prepare("update media set local_path=?, updated_at=datetime('now') where id=?").run(path, row.id);
  return { id: row.id, ok: true, downloaded: true, path, bytes: bytes.byteLength };
}

function extensionFor(url, contentType, mediaType) {
  try {
    const extension = extname(new URL(url).pathname).toLowerCase();
    if (/^\.(jpe?g|png|webp|gif|mp4|mov|m4v|webm|mp3|m4a|wav)$/.test(extension)) return extension;
  } catch {
    // Fall through to content type.
  }
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  if (contentType.includes("mp4")) return ".mp4";
  if (contentType.includes("quicktime")) return ".mov";
  if (contentType.includes("audio")) return ".m4a";
  return mediaType === "video" ? ".mp4" : ".jpg";
}
