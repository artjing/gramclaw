import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ensureDirs, getPaths } from "./config.js";

const execFileAsync = promisify(execFile);
const SOURCE = fileURLToPath(new URL("../native/macos-login.swift", import.meta.url));
const COOKIE_NAMES = new Set(["sessionid", "csrftoken", "ds_user_id", "mid", "ig_did", "rur", "datr", "dpr"]);
export const INSTAGRAM_LOGIN_URL = "https://www.instagram.com/accounts/login/";
const LOGIN_TIMEOUT_MS = 20 * 60 * 1000;
const EXPORT_TIMEOUT_MS = 12_000;

let compilePromise;

export function webviewLoginPaths() {
  const paths = ensureDirs();
  return {
    binary: join(paths.rootDir, "macos-login"),
    storeDir: join(getPaths().runtimeDir, "webview-login"),
    moduleCacheDir: join(paths.runtimeDir, "swift-module-cache"),
    source: SOURCE,
  };
}

export function parseWebviewLoginOutput(stdout) {
  const lines = String(stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith("{")) continue;
    try {
      const payload = JSON.parse(lines[index]);
      if (payload && Array.isArray(payload.cookies)) return payload;
    } catch {
      // Keep scanning; WebKit may print unrelated lines.
    }
  }
  return { ok: false, cookies: [], cancelled: false, error: "malformed" };
}

export function filterWebviewCookies(cookies = []) {
  const seen = new Set();
  const filtered = [];
  for (const cookie of cookies) {
    const name = String(cookie?.name ?? "");
    const value = String(cookie?.value ?? "");
    const domain = String(cookie?.domain ?? "");
    if (!COOKIE_NAMES.has(name) || !value || seen.has(name) || !isInstagramDomain(domain)) continue;
    seen.add(name);
    filtered.push({
      name,
      value,
      domain,
      source: { browser: "webview", profile: "gramclaw-login" },
    });
  }
  return filtered;
}

export async function launchWebviewLogin(options = {}) {
  if (process.platform !== "darwin") {
    throw new Error("The Gramclaw login window is available on macOS.");
  }
  const result = await runWebviewHelper({
    ...options,
    exportOnly: false,
    timeoutMs: Number(options.timeoutMs ?? LOGIN_TIMEOUT_MS),
  });
  if (result.cancelled) {
    const error = new Error("Sign-in was cancelled.");
    error.code = "cancelled";
    throw error;
  }
  return {
    url: options.url ?? INSTAGRAM_LOGIN_URL,
    cookies: result.cookies,
    warnings: result.warnings,
  };
}

export async function readWebviewLoginCookies(options = {}) {
  if (options.webviewCookieLoader) {
    return options.webviewCookieLoader(options);
  }
  if (process.platform !== "darwin") {
    return {
      cookies: [],
      warnings: ["The Gramclaw login window is available on macOS. Import an archive, or use username and password."],
    };
  }
  const result = await runWebviewHelper({
    ...options,
    exportOnly: true,
    timeoutMs: Number(options.timeoutMs ?? EXPORT_TIMEOUT_MS),
  });
  if (result.cookies.length) return { cookies: result.cookies, warnings: [] };
  if (result.cancelled) {
    return { cookies: [], warnings: ["Sign-in was cancelled."] };
  }
  return {
    cookies: [],
    warnings: [result.error === "not_signed_in"
      ? "The Gramclaw login window has no signed-in Instagram session yet. Tap Open Instagram, finish sign-in there, then continue."
      : "Could not read cookies from the Gramclaw login window. Tap Open Instagram, sign in there, then continue."],
  };
}

async function runWebviewHelper(options = {}) {
  const storeDir = options.storeDir ?? (options.runHelper ? "/tmp/gramclaw-webview-login-mock" : webviewLoginPaths().storeDir);
  if (!options.runHelper) {
    mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  }
  const args = [
    "--store",
    storeDir,
    "--login-url",
    options.url ?? INSTAGRAM_LOGIN_URL,
    ...(options.exportOnly ? ["--export"] : []),
  ];
  const spawned = await (options.runHelper ?? spawnWebviewHelper)({
    binary: options.runHelper ? "mock-macos-login" : await macosLoginBinary(),
    args,
    timeoutMs: options.timeoutMs,
  });
  const payload = parseWebviewLoginOutput(spawned.stdout);
  const cookies = filterWebviewCookies(payload.cookies);
  const cancelled = Boolean(payload.cancelled) || spawned.code === 2;
  const error = cancelled ? "cancelled" : (hasSessionPair(cookies) ? "" : (payload.error || "not_signed_in"));
  return {
    cookies,
    cancelled,
    error,
    warnings: [],
    code: spawned.code,
  };
}

export async function macosLoginBinary() {
  const paths = webviewLoginPaths();
  if (
    existsSync(paths.binary)
    && statSync(paths.binary).mtimeMs >= statSync(paths.source).mtimeMs
  ) {
    return paths.binary;
  }
  mkdirSync(paths.moduleCacheDir, { recursive: true, mode: 0o700 });
  compilePromise ??= execFileAsync("swiftc", [
    "-module-cache-path",
    paths.moduleCacheDir,
    paths.source,
    "-O",
    "-o",
    paths.binary,
    "-framework",
    "AppKit",
    "-framework",
    "WebKit",
  ], {
    timeout: 120_000,
    maxBuffer: 2_000_000,
  }).then(() => {
    chmodSync(paths.binary, 0o700);
    return paths.binary;
  }).finally(() => {
    compilePromise = undefined;
  });
  return compilePromise;
}

function spawnWebviewHelper({ binary, args, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: Number(code ?? 1),
        stdout,
        stderr: sanitizeHelperStderr(stderr),
      });
    });
  });
}

function hasSessionPair(cookies) {
  const names = new Set(cookies.map((cookie) => cookie.name));
  return names.has("sessionid") && names.has("csrftoken");
}

function isInstagramDomain(domain) {
  const host = String(domain ?? "").replace(/^\./, "").toLowerCase();
  return host === "instagram.com" || host.endsWith(".instagram.com");
}

function sanitizeHelperStderr(stderr) {
  return String(stderr ?? "")
    .replace(/\/Users\/[^/\s]+/g, "~")
    .slice(0, 240);
}
