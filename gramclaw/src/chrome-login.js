import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getPaths } from "./config.js";

const COOKIE_NAMES = new Set(["sessionid", "csrftoken", "ds_user_id", "mid", "ig_did", "rur", "datr", "dpr"]);
export const CHROME_LOGIN_PORT = 9229;

export function chromeLoginPaths() {
  return {
    userDataDir: join(getPaths().runtimeDir, "chrome-login"),
    binary: process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : process.platform === "win32"
        ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        : "google-chrome",
    port: Number(process.env.GRAMCLAW_CHROME_DEBUG_PORT ?? CHROME_LOGIN_PORT),
  };
}

export function launchChromeLogin(url) {
  const paths = chromeLoginPaths();
  if (process.platform === "darwin" && !existsSync(paths.binary)) {
    throw new Error("Google Chrome was not found in /Applications. Install Chrome, then try again.");
  }
  mkdirSync(paths.userDataDir, { recursive: true, mode: 0o700 });
  const child = spawn(paths.binary, [
    `--user-data-dir=${paths.userDataDir}`,
    `--remote-debugging-port=${paths.port}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    url,
  ], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { url, port: paths.port };
}

export async function readChromeLoginCookies(options = {}) {
  const port = options.port ?? chromeLoginPaths().port;
  const fetchJson = options.fetchJson ?? defaultFetchJson;
  const openSocket = options.openSocket ?? ((wsUrl) => new WebSocket(wsUrl));
  let version;
  try {
    version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
  } catch {
    return {
      cookies: [],
      warnings: ["The Gramclaw Chrome login window is not running. Tap Open Instagram, sign in there, then continue."],
    };
  }
  const wsUrl = version?.webSocketDebuggerUrl;
  if (!wsUrl || !String(wsUrl).startsWith("ws://127.0.0.1")) {
    return { cookies: [], warnings: ["Chrome debug endpoint is not available on loopback."] };
  }
  try {
    const result = await cdpCall(wsUrl, "Network.getAllCookies", {}, {
      openSocket,
      timeoutMs: Number(options.timeoutMs ?? 8_000),
    });
    const cookies = [];
    for (const cookie of result.cookies ?? []) {
      if (!COOKIE_NAMES.has(cookie.name) || !cookie.value) continue;
      if (!isInstagramDomain(cookie.domain)) continue;
      cookies.push({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        source: { browser: "chrome", profile: "gramclaw-login" },
      });
    }
    return { cookies, warnings: [] };
  } catch {
    return {
      cookies: [],
      warnings: ["Could not read cookies from the Gramclaw Chrome login window. Keep that window open and try again."],
    };
  }
}

function isInstagramDomain(domain) {
  const host = String(domain ?? "").replace(/^\./, "").toLowerCase();
  return host === "instagram.com" || host.endsWith(".instagram.com");
}

async function defaultFetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error("Chrome debug HTTP failed.");
  return response.json();
}

function cdpCall(wsUrl, method, params, options) {
  return new Promise((resolve, reject) => {
    const ws = options.openSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* already closed */ }
      reject(new Error("Chrome cookie read timed out."));
    }, options.timeoutMs);
    const finish = (error, result) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve(result);
    };
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
    ws.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(String(event.data ?? ""));
      } catch {
        finish(new Error("Chrome returned a malformed debug message."));
        return;
      }
      if (payload.id !== 1) return;
      if (payload.error) {
        finish(new Error("Chrome debug request failed."));
        return;
      }
      finish(null, payload.result ?? {});
    });
    ws.addEventListener("error", () => finish(new Error("Could not connect to Chrome.")));
  });
}
