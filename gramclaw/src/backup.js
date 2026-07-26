import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getDb, rebuildFts, transaction } from "./db.js";
import { nowIso } from "./utils.js";

const SHARDS = [
  ["accounts", "data/accounts.jsonl"],
  ["profiles", "data/profiles.jsonl"],
  ["profile_snapshots", "data/profile-snapshots.jsonl"],
  ["posts", "data/posts.jsonl"],
  ["media", "data/media.jsonl"],
  ["media_analysis", "data/media-analysis.jsonl"],
  ["comments", "data/comments.jsonl"],
  ["collections", "data/collections.jsonl"],
  ["library_collections", "data/library/collections.jsonl"],
  ["library_collection_items", "data/library/collection-items.jsonl"],
  ["tags", "data/library/tags.jsonl"],
  ["post_tags", "data/library/post-tags.jsonl"],
  ["boards", "data/boards/boards.jsonl"],
  ["board_items", "data/boards/items.jsonl"],
  ["dm_threads", "data/dms/threads.jsonl"],
  ["dm_participants", "data/dms/participants.jsonl"],
  ["dm_messages", "data/dms/messages.jsonl"],
  ["follow_snapshots", "data/network/snapshots.jsonl"],
  ["follow_snapshot_members", "data/network/snapshot-members.jsonl"],
  ["follow_edges", "data/network/edges.jsonl"],
  ["follow_events", "data/network/events.jsonl"],
  ["action_queue", "data/actions.jsonl"],
  ["import_runs", "data/runs/imports.jsonl"],
  ["sync_runs", "data/runs/syncs.jsonl"],
  ["sync_cursors", "data/runs/cursors.jsonl"],
];

const TABLE_SET = new Set(SHARDS.map(([table]) => table));

export function exportBackup(targetDir, options = {}) {
  const db = getDb();
  const root = resolve(targetDir);
  mkdirSync(root, { recursive: true });
  const manifest = {
    format: "gramclaw-jsonl",
    version: 1,
    exportedAt: nowIso(),
    appVersion: options.appVersion ?? "1.1.0",
    shards: [],
  };
  for (const [table, file] of SHARDS) {
    const rows = db.prepare(`select * from ${table} order by rowid`).all();
    const content = rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    manifest.shards.push({
      table,
      file,
      rows: rows.length,
      bytes: Buffer.byteLength(content),
      sha256: sha256(content),
    });
  }
  writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(root, "README.md"), backupReadme());
  return { ok: true, root, manifest };
}

export function validateBackup(targetDir) {
  const root = resolve(targetDir);
  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`Missing backup manifest: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.format !== "gramclaw-jsonl" || manifest.version !== 1) {
    throw new Error("Unsupported Gramclaw backup format.");
  }
  const results = [];
  for (const shard of manifest.shards ?? []) {
    if (!TABLE_SET.has(shard.table)) throw new Error(`Backup contains unsupported table: ${shard.table}`);
    const path = resolve(root, shard.file);
    if (!path.startsWith(root + "/") && path !== root) throw new Error(`Unsafe shard path: ${shard.file}`);
    if (!existsSync(path)) throw new Error(`Missing backup shard: ${shard.file}`);
    const content = readFileSync(path, "utf8");
    const rows = parseJsonl(content, shard.file);
    const actual = {
      rows: rows.length,
      bytes: Buffer.byteLength(content),
      sha256: sha256(content),
    };
    if (actual.rows !== shard.rows || actual.bytes !== shard.bytes || actual.sha256 !== shard.sha256) {
      throw new Error(`Backup shard failed validation: ${shard.file}`);
    }
    results.push({ table: shard.table, file: shard.file, ...actual });
  }
  return { ok: true, root, format: manifest.format, version: manifest.version, shards: results };
}

export function importBackup(targetDir, options = {}) {
  const validation = validateBackup(targetDir);
  const root = resolve(targetDir);
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const db = getDb();
  const counts = {};
  transaction(db, () => {
    if (options.restore) {
      for (const [table] of [...SHARDS].reverse()) db.exec(`delete from ${table}`);
    }
    for (const shard of manifest.shards) {
      const rows = parseJsonl(readFileSync(join(root, shard.file), "utf8"), shard.file);
      counts[shard.table] = rows.length;
      for (const row of rows) insertRow(db, shard.table, row);
    }
  });
  rebuildFts(db);
  return { ok: true, root, restore: Boolean(options.restore), counts, validation };
}

function insertRow(db, table, row) {
  if (!TABLE_SET.has(table)) throw new Error(`Unsupported backup table: ${table}`);
  const columns = Object.keys(row);
  if (!columns.length) return;
  const names = columns.map((column) => `"${column.replace(/"/g, "\"\"")}"`).join(",");
  const placeholders = columns.map(() => "?").join(",");
  db.prepare(`insert or replace into ${table}(${names}) values (${placeholders})`).run(
    ...columns.map((column) => row[column]),
  );
}

export function syncBackup(options = {}) {
  if (!options.repo) throw new Error("backup sync requires --repo <path>.");
  const repo = resolve(options.repo);
  mkdirSync(repo, { recursive: true });
  const gitDir = join(repo, ".git");
  if (!existsSync(gitDir)) {
    execFileSync("git", ["init", "-b", options.branch ?? "main"], { cwd: repo, stdio: "pipe" });
  }
  if (options.remote) {
    const remotes = runGit(repo, ["remote"]).trim().split(/\s+/).filter(Boolean);
    if (!remotes.includes("origin")) runGit(repo, ["remote", "add", "origin", options.remote]);
    else runGit(repo, ["remote", "set-url", "origin", options.remote]);
    try {
      runGit(repo, ["pull", "--rebase", "origin", options.branch ?? "main"]);
    } catch {
      // First push or an empty remote has nothing to pull.
    }
  }
  const exported = exportBackup(repo, options);
  runGit(repo, ["add", "manifest.json", "README.md", "data"]);
  const status = runGit(repo, ["status", "--porcelain"]);
  let committed = false;
  if (status.trim()) {
    runGit(repo, ["commit", "-m", options.message ?? `Gramclaw backup ${new Date().toISOString().slice(0, 10)}`]);
    committed = true;
  }
  let pushed = false;
  if (options.remote && options.push !== false) {
    runGit(repo, ["push", "-u", "origin", options.branch ?? "main"]);
    pushed = true;
  }
  return {
    ok: true,
    repo,
    committed,
    pushed,
    head: runGit(repo, ["rev-parse", "HEAD"]).trim(),
    manifest: exported.manifest,
  };
}

function runGit(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function parseJsonl(content, label) {
  const rows = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error(`Invalid JSONL in ${label} at line ${index + 1}.`);
    }
  }
  return rows;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function backupReadme() {
  return `# Gramclaw text backup

This directory is a deterministic, Git-friendly export of a local Gramclaw workspace.

- \`manifest.json\` records hashes, byte counts, and row counts.
- \`data/*.jsonl\` contains portable canonical rows.
- SQLite indexes, WAL files, browser cookies, tokens, and downloaded media are intentionally excluded.

Validate with \`gramclaw backup validate .\` and restore with \`gramclaw backup import . --restore\`.
`;
}
