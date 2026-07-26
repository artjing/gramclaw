import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";

export function stableId(prefix, ...parts) {
  const hash = createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u001f"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${hash}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function timestampToIso(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (Number.isFinite(number)) {
    const milliseconds = number > 10_000_000_000 ? number : number * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function normalizeUsername(value) {
  return String(value ?? "")
    .trim()
    .replace(/^@/, "")
    .replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, "")
    .split(/[/?#]/)[0]
    .trim()
    .toLowerCase();
}

export function inferUsernameFromUrl(value) {
  try {
    const url = new URL(value);
    if (!/instagram\.com$/i.test(url.hostname) && !/\.instagram\.com$/i.test(url.hostname)) return "";
    const [first] = url.pathname.split("/").filter(Boolean);
    if (!first || ["p", "reel", "reels", "stories", "explore", "direct"].includes(first)) return "";
    return normalizeUsername(first);
  } catch {
    return "";
  }
}

export function shortcodeFromUrl(value) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    const index = parts.findIndex((part) => ["p", "reel", "tv"].includes(part));
    return index >= 0 ? parts[index + 1] ?? "" : "";
  } catch {
    return "";
  }
}

export function json(value, fallback = null) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

export function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function safeFilename(value, fallback = "file") {
  const normalized = basename(String(value ?? fallback))
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

export function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function asBoolean(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

export function createRunId(prefix = "run") {
  return `${prefix}_${randomUUID()}`;
}

export function decodeInstagramText(value) {
  if (typeof value !== "string") return "";
  if (!/[\u00c2\u00c3\u00e2]/.test(value)) return value;
  try {
    const repaired = Buffer.from(value, "latin1").toString("utf8");
    return repaired.includes("\ufffd") ? value : repaired;
  } catch {
    return value;
  }
}

export function parseLimit(value, fallback = 50, max = 1000) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export function printValue(value, asJsonOutput = false) {
  if (asJsonOutput) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (typeof value === "string") {
    process.stdout.write(`${value}\n`);
    return;
  }
  process.stdout.write(`${formatHuman(value)}\n`);
}

function formatHuman(value, indent = 0) {
  if (value === null || value === undefined) return String(value ?? "");
  if (Array.isArray(value)) {
    if (value.length === 0) return "(none)";
    return value.map((item) => `${" ".repeat(indent)}• ${formatHuman(item, indent + 2)}`).join("\n");
  }
  if (typeof value !== "object") return String(value);
  return Object.entries(value)
    .map(([key, item]) => {
      const label = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
      if (Array.isArray(item) || (item && typeof item === "object")) {
        return `${" ".repeat(indent)}${label}:\n${formatHuman(item, indent + 2)}`;
      }
      return `${" ".repeat(indent)}${label}: ${String(item ?? "")}`;
    })
    .join("\n");
}
