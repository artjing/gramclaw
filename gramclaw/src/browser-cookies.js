import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { getCookies } from "@steipete/sweet-cookie";
import { readWebviewLoginCookies } from "./webview-login.js";

const COOKIE_NAMES = ["sessionid", "csrftoken", "ds_user_id", "mid", "ig_did", "rur", "datr", "dpr"];
const INSTAGRAM_ORIGINS = ["https://www.instagram.com/", "https://instagram.com/"];

let rememberedWebviewCookies = [];

const CHROMIUM_TARGETS = [
  { id: "chrome", root: "Google/Chrome", account: "Chrome", service: "Chrome Safe Storage" },
  { id: "brave", root: "BraveSoftware/Brave-Browser", account: "Brave", service: "Brave Safe Storage" },
  { id: "arc", root: "Arc/User Data", account: "Arc", service: "Arc Safe Storage" },
];

export async function loadBrowserCookies(options = {}) {
  const warnings = [];
  const cookies = [];
  if (options.cookies?.length) {
    cookies.push(...options.cookies);
    rememberWebviewCookies(cookies);
    if (hasSessionPair(cookies)) return { cookies, warnings };
  }
  if (!hasSessionPair(cookies) && hasSessionPair(rememberedWebviewCookies)) {
    cookies.push(...rememberedWebviewCookies);
    if (hasSessionPair(cookies)) return { cookies, warnings };
  }
  if (options.webviewLogin && !options.skipWebviewLogin) {
    const webview = await (options.webviewCookieLoader ?? readWebviewLoginCookies)(options);
    cookies.push(...(webview.cookies ?? []));
    warnings.push(...(webview.warnings ?? []));
    rememberWebviewCookies(cookies);
  }
  if (hasSessionPair(cookies) || options.skipSystemBrowsers) return { cookies, warnings };

  try {
    const sweet = await (options.browserCookieLoader ?? getCookies)({
      url: INSTAGRAM_ORIGINS[0],
      origins: INSTAGRAM_ORIGINS,
      names: COOKIE_NAMES,
      browsers: options.browsers ?? ["chrome", "safari", "firefox", "edge"],
      timeoutMs: Number(options.cookieTimeout ?? 30_000),
      mode: "merge",
      debug: true,
      ...(options.chromeProfile ? { chromeProfile: options.chromeProfile } : {}),
    });
    cookies.push(...(sweet.cookies ?? []));
    warnings.push(...sanitizeCookieWarnings(sweet.warnings ?? []));
  } catch (error) {
    warnings.push(sanitizeCookieWarning(error instanceof Error ? error.message : String(error)));
  }

  if (!hasSessionPair(cookies)) {
    const fallback = readChromiumInstagramCookies({
      dbPath: options.chromeCookiesDb,
      profileRoot: options.chromeProfile,
    });
    cookies.push(...fallback.cookies);
    warnings.push(...fallback.warnings);
  }

  return { cookies, warnings };
}

export function readChromiumInstagramCookies(options = {}) {
  const warnings = [];
  const cookies = [];
  const dbs = options.dbPath
    ? [{ dbPath: options.dbPath, id: "chrome" }]
    : findChromiumCookieDbs(options.profileRoot);
  if (!dbs.length) {
    return { cookies, warnings: ["No Chrome/Brave/Arc cookie database was found."] };
  }
  for (const db of dbs) {
    const snapshot = snapshotCookieDb(db.dbPath);
    if (!snapshot.ok) {
      warnings.push(snapshot.warning);
      continue;
    }
    try {
      const rows = queryInstagramCookieRows(snapshot.dbPath);
      const decrypt = createChromiumDecryptor(db.id, warnings, rows.metaVersion >= 24);
      for (const row of rows.cookies) {
        const value = decodeCookieRow(row, decrypt, warnings);
        if (!value) continue;
        cookies.push({
          name: row.name,
          value,
          domain: row.host_key,
          source: { browser: "chrome", profile: basename(db.dbPath) },
        });
      }
    } catch (error) {
      warnings.push(`Failed to read ${db.id} cookies: ${sanitizeCookieWarning(error instanceof Error ? error.message : String(error))}`);
    } finally {
      rmSync(snapshot.tempDir, { recursive: true, force: true });
    }
  }
  return { cookies, warnings };
}

function hasSessionPair(cookies) {
  const names = new Set(cookies.filter((cookie) => cookie.value).map((cookie) => cookie.name));
  return names.has("sessionid") && names.has("csrftoken");
}

function rememberWebviewCookies(cookies) {
  if (!hasSessionPair(cookies)) return;
  rememberedWebviewCookies = cookies.filter((cookie) => cookie?.name && cookie?.value);
}

function findChromiumCookieDbs(profileRoot) {
  if (profileRoot) {
    const direct = [
      join(profileRoot, "Network", "Cookies"),
      join(profileRoot, "Cookies"),
    ].find((path) => existsSync(path));
    return direct ? [{ dbPath: direct, id: "chrome" }] : [];
  }
  const found = [];
  for (const target of CHROMIUM_TARGETS) {
    const root = join(homedir(), "Library/Application Support", target.root);
    if (!existsSync(root)) continue;
    const profiles = ["Default", ...readdirSync(root).filter((name) => name.startsWith("Profile "))];
    for (const profile of profiles) {
      const dbPath = join(root, profile, "Network", "Cookies");
      if (existsSync(dbPath)) found.push({ dbPath, id: target.id });
    }
  }
  return found;
}

function snapshotCookieDb(dbPath) {
  const tempDir = mkdtempSync(join(tmpdir(), "gramclaw-cookies-"));
  const dest = join(tempDir, "Cookies");
  try {
    copyFileSync(dbPath, dest);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${dbPath}${suffix}`)) copyFileSync(`${dbPath}${suffix}`, `${dest}${suffix}`);
    }
    return { ok: true, dbPath: dest, tempDir };
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    return {
      ok: false,
      warning: `Could not copy browser cookies: ${sanitizeCookieWarning(error instanceof Error ? error.message : String(error))}`,
    };
  }
}

function queryInstagramCookieRows(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    let metaVersion = 0;
    try {
      const meta = db.prepare("SELECT value FROM meta WHERE key = 'version'").get();
      metaVersion = Number(meta?.value ?? 0);
    } catch {
      metaVersion = 0;
    }
    const cookies = db.prepare(`
      SELECT name, value, host_key, encrypted_value
      FROM cookies
      WHERE (host_key = '.instagram.com' OR host_key LIKE '%instagram.com')
        AND name IN ('sessionid', 'csrftoken', 'ds_user_id', 'mid', 'ig_did', 'rur', 'datr', 'dpr')
    `).all();
    return { cookies, metaVersion };
  } finally {
    db.close();
  }
}

function decodeCookieRow(row, decrypt, warnings) {
  if (typeof row.value === "string" && row.value) return row.value;
  const encrypted = toBuffer(row.encrypted_value);
  if (!encrypted?.length) return null;
  const prefix = encrypted.subarray(0, 3).toString("utf8");
  if (prefix === "v20") {
    warnings.push("Chrome stored this Instagram session with app-bound encryption that Gramclaw cannot read. Try Safari, or sign in with a browser Gramclaw can read.");
    return null;
  }
  return decrypt(encrypted);
}

function createChromiumDecryptor(browserId, warnings, stripHashPrefix) {
  const target = CHROMIUM_TARGETS.find((item) => item.id === browserId) ?? CHROMIUM_TARGETS[0];
  let key;
  return (encrypted) => {
    key ??= readChromiumKey(target, warnings);
    if (!key) return null;
    return decryptChromiumCookie(encrypted, key, stripHashPrefix);
  };
}

function readChromiumKey(target, warnings) {
  const result = spawnSync("security", [
    "find-generic-password",
    "-w",
    "-a",
    target.account,
    "-s",
    target.service,
  ], {
    encoding: "utf8",
    timeout: 8_000,
  });
  if (result.status !== 0) {
    warnings.push(`Could not read the ${target.account} keychain item needed to decrypt cookies.`);
    return null;
  }
  const password = String(result.stdout ?? "").trim();
  if (!password) {
    warnings.push(`The ${target.account} keychain item was empty.`);
    return null;
  }
  return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

function decryptChromiumCookie(encryptedValue, key, stripHashPrefix) {
  const buf = Buffer.from(encryptedValue);
  if (buf.length < 4) return null;
  const payload = /^v\d\d$/.test(buf.subarray(0, 3).toString("utf8")) ? buf.subarray(3) : buf;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
    const bytes = stripHashPrefix && plaintext.length > 32 ? plaintext.subarray(32) : plaintext;
    return bytes.toString("utf8");
  } catch {
    return null;
  }
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

function sanitizeCookieWarnings(warnings) {
  return warnings.map((warning) => sanitizeCookieWarning(warning)).filter(Boolean);
}

function sanitizeCookieWarning(warning) {
  return String(warning ?? "")
    .replace(/\/Users\/[^/\s]+/g, "~")
    .replace(/value of column \d+[^.]+/gi, "a Chrome cookie timestamp")
    .slice(0, 240);
}
