import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  clearInstagramAuthMetadata,
  ensureDirs,
  getInstagramAuthMetadata,
  loadConfig,
  setHomeOverride,
  setInstagramAuthMetadata,
} from "../src/config.js";
import {
  closeDb,
  defaultAccount,
  ensureAccount,
  getDb,
  seedDemoData,
  setDefaultAccount,
} from "../src/db.js";
import {
  InstagramLoginAttempt,
  loadDirectCredentials,
  prepareInstagramAuth,
  redactAuthValue,
  runSidecarOperation,
  sidecarEnvironment,
  sidecarInvocation,
  startInstagramLogin,
} from "../src/instagram-auth.js";
import { resolveCredentials, webRequest } from "../src/live.js";
import { serve } from "../src/server.js";
import { promptHidden } from "../src/terminal-prompt.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-instagram-sidecar.py", import.meta.url));
const PASSWORD = "node-password-canary-7788";
const CODE = "node-code-canary-9911";
const CLI = fileURLToPath(new URL("../bin/gramclaw.mjs", import.meta.url));
const WEB_HTML = fileURLToPath(new URL("../web/index.html", import.meta.url));
const WEB_APP = fileURLToPath(new URL("../web/app.js", import.meta.url));
const WEB_STYLES = fileURLToPath(new URL("../web/styles.css", import.meta.url));

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "gramclaw-auth-test-"));
  setHomeOverride(join(root, "home"));
  closeDb();
  return {
    root,
    cleanup() {
      closeDb();
      setHomeOverride(undefined);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function runtime() {
  return prepareInstagramAuth({ sidecarPath: FIXTURE });
}

test("sidecar invocation never places a password or session in argv or env", async () => {
  process.env.GRAMCLAW_PASSWORD = PASSWORD;
  process.env.GRAMCLAW_SESSIONID = "environment-session-canary";
  try {
    const prepared = await runtime();
    const invocation = sidecarInvocation(prepared);
    const snapshot = JSON.stringify(invocation);
    assert.equal(invocation.args.length, 1);
    assert.equal(invocation.args[0], FIXTURE);
    assert.doesNotMatch(snapshot, /node-password-canary|environment-session-canary/);
    assert.equal(sidecarEnvironment().GRAMCLAW_PASSWORD, undefined);
    assert.equal(sidecarEnvironment().GRAMCLAW_SESSIONID, undefined);
  } finally {
    delete process.env.GRAMCLAW_PASSWORD;
    delete process.env.GRAMCLAW_SESSIONID;
  }
});

test("NDJSON parser handles chunked and multiple messages", async () => {
  const prepared = await runtime();
  const attempt = new InstagramLoginAttempt(prepared, { timeoutMs: 2_000 })
    .start("example", PASSWORD);
  const state = await attempt.nextMessage();
  const result = await attempt.nextMessage();
  assert.deepEqual(state, { v: 1, type: "state", state: "signing_in" });
  assert.equal(result.type, "result");
  assert.equal(result.identity.username, "example");
  assert.doesNotMatch(JSON.stringify([state, result]), new RegExp(`${PASSWORD}|result-password-canary|result-session-canary`));
});

for (const [username, kind] of [
  ["twofactor", "two_factor"],
  ["challenge", "challenge_code"],
  ["manual", "manual_approval"],
]) {
  test(`${kind} prompt stays in one child and resumes safely`, async () => {
    const prepared = await runtime();
    const attempt = new InstagramLoginAttempt(prepared, { timeoutMs: 2_000 })
      .start(username, PASSWORD);
    await attempt.nextMessage();
    const prompt = await attempt.nextMessage();
    assert.equal(prompt.kind, kind);
    if (kind === "manual_approval") {
      assert.equal(prompt.instruction, "Approve this login in the official Instagram app, then continue.");
    }
    attempt.respond(prompt.id, CODE);
    const result = await attempt.nextMessage();
    assert.equal(result.ok, true);
    const transcript = JSON.stringify([prompt, result]);
    assert.doesNotMatch(transcript, new RegExp(PASSWORD));
    assert.doesNotMatch(transcript, new RegExp(CODE));
  });
}

test("malformed protocol and timeout errors never echo child input", async () => {
  const prepared = await runtime();
  for (const [username, timeoutMs] of [["malformed", 2_000], ["timeout", 40]]) {
    const attempt = new InstagramLoginAttempt(prepared, { timeoutMs })
      .start(username, PASSWORD);
    const error = await attempt.nextMessage({ actionable: true });
    assert.equal(error.type, "error");
    assert.equal(error.code, "protocol_error");
    assert.doesNotMatch(JSON.stringify(error), new RegExp(PASSWORD));
  }
});

test("cancel terminates a blocked prompt with a sanitized result", async () => {
  const prepared = await runtime();
  const attempt = new InstagramLoginAttempt(prepared, { timeoutMs: 2_000 })
    .start("twofactor", PASSWORD);
  await attempt.nextMessage();
  await attempt.nextMessage();
  attempt.cancel();
  const message = await attempt.nextMessage();
  assert.equal(message.code, "cancelled");
  assert.doesNotMatch(JSON.stringify(message), new RegExp(PASSWORD));
});

test("one-shot sidecar operations are sanitized and credentials stay internal", async () => {
  const prepared = await runtime();
  const status = await runSidecarOperation("status", { credentialId: "ig:123" }, {
    runtime: prepared,
  });
  assert.equal(status.available, true);
  const credentials = await runSidecarOperation("credentials", { credentialId: "ig:123" }, {
    runtime: prepared,
  });
  assert.equal(credentials.credentials.cookies.sessionid, "session-secret-canary");
  assert.equal(credentials.credentials.cookies.ignored_cookie, "must-not-cross");
});

test("public credential adapter drops every cookie outside the transport allowlist", async () => {
  const scope = workspace();
  try {
    setInstagramAuthMetadata({
      credentialId: "ig:123",
      username: "example",
      userId: "123",
      connectedAt: "2026-07-26T00:00:00.000Z",
    });
    const credentials = await loadDirectCredentials({ sidecarPath: FIXTURE });
    assert.equal(credentials.source, "instagrapi-session");
    assert.match(credentials.cookieHeader, /sessionid=session-secret-canary/);
    assert.match(credentials.cookieHeader, /csrftoken=csrf-secret-canary/);
    assert.doesNotMatch(credentials.cookieHeader, /ignored_cookie|must-not-cross/);
  } finally {
    scope.cleanup();
  }
});

test("redactor strips credential fields and masked contact details", () => {
  const redacted = redactAuthValue({
    password: PASSWORD,
    nested: {
      cookies: { sessionid: "secret" },
      note: "Contact e***@example.com or +1 (555) 123-4567",
    },
  });
  const snapshot = JSON.stringify(redacted);
  assert.doesNotMatch(snapshot, /node-password-canary|sessionid|example\.com|555/);
  assert.match(snapshot, /redacted/);
});

test("old config merges defaults and auth metadata remains safe with mode 0600", () => {
  const scope = workspace();
  try {
    const paths = ensureDirs();
    writeFileSync(paths.configPath, '{"transport":{"preferred":"archive"}}\n');
    const loaded = loadConfig();
    assert.equal(loaded.transport.preferred, "archive");
    assert.equal(loaded.transport.graphVersion, "v24.0");
    assert.equal(loaded.server.host, "127.0.0.1");
    setInstagramAuthMetadata({
      credentialId: "ig:123",
      username: "@example",
      userId: 123,
      connectedAt: "2026-07-26T00:00:00.000Z",
      lastVerifiedAt: "2026-07-26T01:00:00.000Z",
      password: PASSWORD,
      cookies: "cookie-canary",
    });
    assert.deepEqual(getInstagramAuthMetadata(), {
      credentialId: "ig:123",
      username: "example",
      userId: "123",
      connectedAt: "2026-07-26T00:00:00.000Z",
      lastVerifiedAt: "2026-07-26T01:00:00.000Z",
    });
    const configText = readFileSync(paths.configPath, "utf8");
    assert.doesNotMatch(configText, /node-password-canary|cookie-canary/);
    assert.equal(statSync(paths.configPath).mode & 0o777, 0o600);
    clearInstagramAuthMetadata();
    assert.equal(getInstagramAuthMetadata(), null);
  } finally {
    scope.cleanup();
  }
});

test("credential precedence is explicit, then direct, then browser", async () => {
  let directCalls = 0;
  let browserCalls = 0;
  const directCredentialLoader = async () => {
    directCalls += 1;
    return {
      sessionId: "direct-session",
      csrfToken: "direct-csrf",
      userId: "2",
      cookieHeader: "sessionid=direct-session; csrftoken=direct-csrf",
      source: "instagrapi-session",
      warnings: [],
    };
  };
  const browserCookieLoader = async () => {
    browserCalls += 1;
    return {
      cookies: [
        { name: "sessionid", value: "browser-session" },
        { name: "csrftoken", value: "browser-csrf" },
      ],
      warnings: [],
    };
  };
  const explicit = await resolveCredentials({
    sessionId: "explicit-session",
    csrfToken: "explicit-csrf",
    directCredentialLoader,
    browserCookieLoader,
  });
  assert.equal(explicit.source, "env-or-flags");
  assert.equal(directCalls, 0);
  assert.equal(browserCalls, 0);
  const direct = await resolveCredentials({ directCredentialLoader, browserCookieLoader });
  assert.equal(direct.source, "instagrapi-session");
  assert.equal(directCalls, 1);
  assert.equal(browserCalls, 0);
  const browser = await resolveCredentials({
    directCredentialLoader: async () => null,
    browserCookieLoader,
  });
  assert.equal(browser.source, "browser");
  assert.equal(browser.sessionId, "browser-session");
  assert.equal(browserCalls, 1);
});

test("web transport persists only allowlisted rotated cookies for direct sessions", async () => {
  const originalFetch = globalThis.fetch;
  let merged;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, status: "ok" }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": "csrftoken=rotated-csrf; Path=/, ignored_cookie=nope; Path=/",
    },
  });
  try {
    const payload = await webRequest("/api/test", {
      credentials: {
        sessionId: "direct-session",
        csrfToken: "direct-csrf",
        userId: "123",
        cookieHeader: "sessionid=direct-session; csrftoken=direct-csrf",
        source: "instagrapi-session",
        warnings: [],
      },
      directCookieMerger: async (cookies) => {
        merged = cookies;
      },
    });
    assert.equal(payload.ok, true);
    assert.deepEqual(merged, { csrftoken: "rotated-csrf" });
    let browserMergeCalled = false;
    await webRequest("/api/test", {
      credentials: {
        sessionId: "browser-session",
        csrfToken: "browser-csrf",
        userId: "123",
        cookieHeader: "sessionid=browser-session; csrftoken=browser-csrf",
        source: "browser",
        warnings: [],
      },
      directCookieMerger: async () => {
        browserMergeCalled = true;
      },
    });
    assert.equal(browserMergeCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("direct-session 401 errors are actionable and never expose Instagram payloads", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: "fail",
    message: "login_required",
    sessionid: "response-session-canary",
  }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
  try {
    await assert.rejects(
      webRequest("/api/test", {
        credentials: {
          sessionId: "direct-session",
          csrfToken: "direct-csrf",
          userId: "123",
          cookieHeader: "sessionid=direct-session; csrftoken=direct-csrf",
          source: "instagrapi-session",
          warnings: [],
        },
      }),
      (error) => {
        assert.equal(error.code, "session_expired");
        assert.match(error.message, /gramclaw login/);
        assert.doesNotMatch(error.message, /response-session-canary|login_required/);
        assert.equal(error.payload, undefined);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verified account identity replaces demo/archive default without duplicate usernames", () => {
  const scope = workspace();
  try {
    const db = getDb();
    const archive = ensureAccount(db, {
      username: "example",
      displayName: "Archive Example",
      transport: "archive",
    });
    const connected = ensureAccount(db, {
      externalUserId: "123",
      username: "example",
      displayName: "Connected Example",
      transport: "cookie",
    });
    setDefaultAccount(db, connected.id);
    assert.equal(connected.id, archive.id);
    assert.equal(defaultAccount(db).id, archive.id);
    assert.equal(db.prepare("select count(*) count from accounts where username='example'").get().count, 1);
  } finally {
    scope.cleanup();
  }
});

test("verified numeric identity upgrades the demo account instead of creating a username duplicate", () => {
  const scope = workspace();
  try {
    const db = getDb();
    seedDemoData(db);
    const connected = ensureAccount(db, {
      externalUserId: "987654321",
      username: "studio.marea",
      displayName: "Marea Studio",
      transport: "cookie",
    });
    setDefaultAccount(db, connected.id);
    assert.equal(connected.id, "acct_demo");
    assert.equal(defaultAccount(db).external_user_id, "987654321");
    assert.equal(db.prepare("select count(*) count from accounts where username='studio.marea'").get().count, 1);
  } finally {
    scope.cleanup();
  }
});

test("hidden terminal prompt returns input without echoing password or code", async () => {
  for (const secret of [PASSWORD, CODE]) {
    const input = new PassThrough();
    const output = new PassThrough();
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (value) => {
      input.isRaw = value;
      return input;
    };
    let transcript = "";
    output.on("data", (chunk) => {
      transcript += String(chunk);
    });
    const resultPromise = promptHidden("Secret: ", { input, output });
    setImmediate(() => input.write(`${secret}\r`));
    assert.equal(await resultPromise, secret);
    assert.equal(transcript, "Secret: \n");
    assert.doesNotMatch(transcript, new RegExp(secret));
  }
});

test("non-interactive CLI login, status, and logout expose only sanitized JSON", () => {
  const scope = workspace();
  try {
    const home = join(scope.root, "cli-home");
    const environment = {
      ...process.env,
      GRAMCLAW_INSTAGRAM_SIDECAR: FIXTURE,
    };
    delete environment.GRAMCLAW_PASSWORD;
    const login = spawnSync(process.execPath, [
      CLI,
      "--home",
      home,
      "--json",
      "login",
      "example",
      "--accept-private-api-risk",
      "--password-stdin",
      "--no-verify-web",
    ], {
      env: environment,
      input: `${PASSWORD}\n`,
      encoding: "utf8",
    });
    assert.equal(login.status, 0, login.stderr);
    const result = JSON.parse(login.stdout);
    assert.equal(result.connected, true);
    assert.equal(result.verified, false);
    assert.equal(result.passwordStored, false);
    assert.doesNotMatch(login.stdout, new RegExp(PASSWORD));
    assert.doesNotMatch(login.stderr, new RegExp(PASSWORD));
    const config = readFileSync(join(home, "config.json"), "utf8");
    assert.doesNotMatch(config, /node-password-canary|session-secret-canary|csrf-secret-canary/);

    const status = spawnSync(process.execPath, [
      CLI,
      "--home",
      home,
      "--json",
      "auth",
      "status",
    ], { env: environment, encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.direct.configured, true);
    assert.equal(statusPayload.direct.available, true);
    assert.equal(statusPayload.direct.verified, false);
    assert.doesNotMatch(status.stdout, /session-secret-canary|csrf-secret-canary/);
    const configShow = spawnSync(process.execPath, [
      CLI,
      "--home",
      home,
      "--json",
      "config",
      "show",
    ], { env: environment, encoding: "utf8" });
    assert.equal(configShow.status, 0, configShow.stderr);

    const backupDir = join(scope.root, "backup");
    const backup = spawnSync(process.execPath, [
      CLI,
      "--home",
      home,
      "--json",
      "backup",
      "export",
      backupDir,
    ], { env: environment, encoding: "utf8" });
    assert.equal(backup.status, 0, backup.stderr);
    const persistedSnapshot = [
      readFileSync(join(home, "gramclaw.sqlite")),
      ...readFilesRecursively(backupDir),
      readFileSync(join(home, "config.json")),
      configShow.stdout,
      status.stdout,
      ...readFilesRecursively(join(home, "audit")),
      ...readFilesRecursively(join(home, "logs")),
    ].map(String).join("\n");
    assert.doesNotMatch(
      persistedSnapshot,
      /node-password-canary|session-secret-canary|csrf-secret-canary|authorization-secret-canary/,
    );

    const logout = spawnSync(process.execPath, [
      CLI,
      "--home",
      home,
      "--json",
      "logout",
    ], { env: environment, encoding: "utf8" });
    assert.equal(logout.status, 0, logout.stderr);
    assert.equal(JSON.parse(logout.stdout).disconnected, true);
    assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).auth.instagram, undefined);

    const aliasLogin = spawnSync(process.execPath, [
      CLI,
      "--home",
      home,
      "--json",
      "auth",
      "login",
      "example",
      "--accept-private-api-risk",
      "--password-stdin",
      "--no-verify-web",
    ], {
      env: environment,
      input: `${PASSWORD}\n`,
      encoding: "utf8",
    });
    assert.equal(aliasLogin.status, 0, aliasLogin.stderr);
    assert.equal(JSON.parse(aliasLogin.stdout).connected, true);
    const blockedConfigSecret = spawnSync(process.execPath, [
      CLI,
      "--home",
      home,
      "config",
      "set",
      "auth.instagram.password",
      "blocked-value",
    ], { env: environment, encoding: "utf8" });
    assert.notEqual(blockedConfigSecret.status, 0);
    assert.doesNotMatch(readFileSync(join(home, "config.json"), "utf8"), /blocked-value/);
  } finally {
    scope.cleanup();
  }
});

function readFilesRecursively(root) {
  const values = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) values.push(...readFilesRecursively(path));
    else values.push(readFileSync(path));
  }
  return values;
}

function fakeAuthApi(overrides = {}) {
  return {
    startLogin: (options) => startInstagramLogin({
      ...options,
      sidecarPath: FIXTURE,
      timeoutMs: 2_000,
    }),
    completeLogin: async (result) => ({
      ok: true,
      connected: true,
      username: result.identity.username,
      userId: result.identity.userId,
      credentialSource: "instagrapi-session",
      verified: true,
      passwordStored: false,
    }),
    status: async () => ({
      configured: false,
      available: false,
      username: null,
      userId: null,
      verified: false,
      source: "system-credential-store",
      warnings: [],
    }),
    verify: async () => ({ ok: true, connected: true, verified: true }),
    logout: async () => ({ ok: true, disconnected: true, deleted: true }),
    ...overrides,
  };
}

async function authFetch(baseUrl, path, options = {}) {
  const origin = new URL(baseUrl).origin;
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.method && options.method !== "GET"
        ? { "content-type": "application/json", origin }
        : {}),
      ...(options.headers ?? {}),
    },
  });
}

async function withAuthServer(options, callback) {
  const scope = workspace();
  let server;
  try {
    const running = await serve({
      host: "127.0.0.1",
      port: 0,
      instagramAuth: fakeAuthApi(),
      ...options,
    });
    server = running.server;
    return await callback(running);
  } finally {
    if (server?.listening) await new Promise((resolvePromise) => server.close(resolvePromise));
    scope.cleanup();
  }
}

test("web auth routes handle login, challenge response, status, verify, and logout", async () => {
  await withAuthServer({}, async ({ url }) => {
    const statusResponse = await authFetch(url, "/api/auth/status");
    assert.equal(statusResponse.status, 200);
    assert.equal((await statusResponse.json()).direct.verified, false);

    const start = await authFetch(url, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: "twofactor",
        password: PASSWORD,
        acceptPrivateApiRisk: true,
      }),
    });
    assert.equal(start.status, 202);
    assert.equal(start.headers.get("cache-control"), "no-store");
    assert.equal(start.headers.get("access-control-allow-origin"), null);
    const prompt = await start.json();
    assert.equal(prompt.state, "needs_2fa");
    assert.ok(prompt.attemptId.length >= 32);
    assert.doesNotMatch(JSON.stringify(prompt), new RegExp(PASSWORD));

    const respond = await authFetch(url, `/api/auth/login/${prompt.attemptId}/respond`, {
      method: "POST",
      body: JSON.stringify({ promptId: prompt.prompt.id, value: CODE }),
    });
    assert.equal(respond.status, 200);
    const connected = await respond.json();
    assert.equal(connected.connected, true);
    assert.doesNotMatch(JSON.stringify(connected), new RegExp(`${PASSWORD}|${CODE}|result-password-canary|result-session-canary`));

    assert.equal((await authFetch(url, "/api/auth/verify", {
      method: "POST",
      body: "{}",
    })).status, 200);
    const logout = await authFetch(url, "/api/auth/logout", {
      method: "POST",
      body: "{}",
    });
    assert.match((await logout.json()).message, /Other Instagram devices/);
  });
});

test("web auth boundary rejects remote password login, bad origin, and missing app token", async () => {
  const previousRemote = process.env.GRAMCLAW_ALLOW_REMOTE_WEB;
  const previousToken = process.env.GRAMCLAW_WEB_TOKEN;
  process.env.GRAMCLAW_ALLOW_REMOTE_WEB = "1";
  const scope = workspace();
  let server;
  try {
    const remote = await serve({
      host: "0.0.0.0",
      port: 0,
      instagramAuth: fakeAuthApi(),
    });
    server = remote.server;
    const denied = await authFetch(remote.url, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: "example",
        password: PASSWORD,
        acceptPrivateApiRisk: true,
      }),
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, "remote_login_disabled");
    await new Promise((resolvePromise) => server.close(resolvePromise));
    server = null;

    process.env.GRAMCLAW_WEB_TOKEN = "app-token";
    const loopback = await serve({
      host: "127.0.0.1",
      port: 0,
      instagramAuth: fakeAuthApi(),
    });
    server = loopback.server;
    const missingToken = await authFetch(loopback.url, "/api/auth/status");
    assert.equal(missingToken.status, 401);
    const badOrigin = await authFetch(loopback.url, "/api/auth/login", {
      method: "POST",
      headers: {
        origin: "http://evil.example",
        "x-gramclaw-token": "app-token",
      },
      body: JSON.stringify({
        username: "example",
        password: PASSWORD,
        acceptPrivateApiRisk: true,
      }),
    });
    assert.equal(badOrigin.status, 403);
    const allowed = await authFetch(loopback.url, "/api/auth/status", {
      headers: { "x-gramclaw-token": "app-token" },
    });
    assert.equal(allowed.status, 200);
  } finally {
    if (server) await new Promise((resolvePromise) => server.close(resolvePromise));
    scope.cleanup();
    if (previousRemote === undefined) delete process.env.GRAMCLAW_ALLOW_REMOTE_WEB;
    else process.env.GRAMCLAW_ALLOW_REMOTE_WEB = previousRemote;
    if (previousToken === undefined) delete process.env.GRAMCLAW_WEB_TOKEN;
    else process.env.GRAMCLAW_WEB_TOKEN = previousToken;
  }
});

test("attempt registry rejects guesses and duplicates, expires, cancels, and rate limits", async () => {
  await withAuthServer({
    authAttemptTimeoutMs: 1_000,
    authRateLimit: 4,
  }, async ({ url }) => {
    const start = await authFetch(url, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: "challenge",
        password: PASSWORD,
        acceptPrivateApiRisk: true,
      }),
    });
    const prompt = await start.json();
    const guessed = await authFetch(url, "/api/auth/login/not-a-real-attempt/respond", {
      method: "POST",
      body: JSON.stringify({ promptId: prompt.prompt.id, value: CODE }),
    });
    assert.equal(guessed.status, 404);
    const duplicate = await authFetch(url, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: "example",
        password: PASSWORD,
        acceptPrivateApiRisk: true,
      }),
    });
    assert.equal(duplicate.status, 409);
    const cancelled = await authFetch(url, `/api/auth/login/${prompt.attemptId}`, {
      method: "DELETE",
    });
    assert.equal(cancelled.status, 200);
  });

  await withAuthServer({
    authAttemptTimeoutMs: 35,
    authRateLimit: 2,
  }, async ({ url }) => {
    const expiring = await authFetch(url, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: "manual",
        password: PASSWORD,
        acceptPrivateApiRisk: true,
      }),
    });
    const expiringPrompt = await expiring.json();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 45));
    const expired = await authFetch(url, `/api/auth/login/${expiringPrompt.attemptId}/respond`, {
      method: "POST",
      body: JSON.stringify({ promptId: expiringPrompt.prompt.id, value: "continue" }),
    });
    assert.equal(expired.status, 404);
  });

  await withAuthServer({
    authRateLimit: 1,
    authRateWindowMs: 10_000,
  }, async ({ url }) => {
    const first = await authFetch(url, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: "bad",
        password: PASSWORD,
        acceptPrivateApiRisk: true,
      }),
    });
    assert.equal(first.status, 400);
    const limited = await authFetch(url, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: "example",
        password: PASSWORD,
        acceptPrivateApiRisk: true,
      }),
    });
    assert.equal(limited.status, 429);
  });
});

test("server shutdown cancels a blocked authentication child", async () => {
  let cancelled = false;
  const blockedAttempt = {
    id: "blocked-attempt-with-high-entropy-placeholder",
    cancel() {
      cancelled = true;
    },
    async nextMessage() {
      return {
        v: 1,
        type: "prompt",
        id: "blocked-prompt",
        kind: "manual_approval",
        channel: null,
        maskedDestination: null,
      };
    },
    respond() {},
  };
  await withAuthServer({
    instagramAuth: fakeAuthApi({
      startLogin: async () => blockedAttempt,
    }),
  }, async ({ url, server }) => {
    const response = await authFetch(url, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: "manual",
        password: PASSWORD,
        acceptPrivateApiRisk: true,
      }),
    });
    assert.equal(response.status, 202);
    await new Promise((resolvePromise) => server.close(resolvePromise));
    assert.equal(cancelled, true);
  });
});

test("aborting the first login request cancels the child once runtime preparation finishes", async () => {
  let cancelled = false;
  const delayedAttempt = {
    id: "delayed-attempt-with-high-entropy-placeholder",
    cancel() {
      cancelled = true;
    },
    async nextMessage() {
      return new Promise(() => {});
    },
    respond() {},
  };
  await withAuthServer({
    instagramAuth: fakeAuthApi({
      startLogin: async () => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 35));
        return delayedAttempt;
      },
    }),
  }, async ({ url }) => {
    const controller = new AbortController();
    const pending = authFetch(url, "/api/auth/login", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        username: "example",
        password: PASSWORD,
        acceptPrivateApiRisk: true,
      }),
    });
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(pending, /abort/i);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 55));
    assert.equal(cancelled, true);
  });
});

test("web auth routes require JSON and enforce the small credential body limit", async () => {
  await withAuthServer({ authRateLimit: 5 }, async ({ url }) => {
    const origin = new URL(url).origin;
    const wrongType = await fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: { origin, "content-type": "text/plain" },
      body: "not-json",
    });
    assert.equal(wrongType.status, 415);
    const oversized = await authFetch(url, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: "example",
        password: "x".repeat(17_000),
        acceptPrivateApiRisk: true,
      }),
    });
    assert.equal(oversized.status, 413);
    assert.doesNotMatch(await oversized.text(), /x{20}/);
  });
});

test("onboarding markup implements the required accessible states and secret-clearing rules", () => {
  const html = readFileSync(WEB_HTML, "utf8");
  const app = readFileSync(WEB_APP, "utf8");
  const styles = readFileSync(WEB_STYLES, "utf8");
  assert.match(html, /id="auth-onboarding"[^>]+aria-labelledby="auth-title"/);
  assert.match(html, /id="account-pill"[^>]+aria-haspopup="dialog"/);
  for (const copy of [
    "Your Instagram,",
    "Import your archive",
    "Import archive ZIP",
    "Enable update sync later (optional)",
    "Skip for now",
    "Enable update sync",
    "Import an archive instead",
    "Use a signed-in browser",
    "I've approved it — continue",
    "Append 30 recent posts",
    "Session saved securely · password not saved.",
    "Direct sign-in uses Instagram's unofficial private API.",
    "Finishing connection…",
    "Choose your ZIP",
  ]) {
    assert.match(app, new RegExp(copy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const authState of [
    "idle",
    "import",
    "importing",
    "import_done",
    "import_error",
    "login",
    "preparing_runtime",
    "signing_in",
    "verifying",
    "needs_2fa",
    "needs_challenge_code",
    "needs_manual_approval",
    "success",
    "error",
  ]) {
    assert.match(app, new RegExp(`["']${authState}["']`));
  }
  assert.match(app, /autocomplete="username"/);
  assert.match(app, /autocomplete="current-password"/);
  assert.match(app, /autocomplete="one-time-code"/);
  assert.match(app, /form\.elements\.password\.value = ""/);
  assert.match(app, /input\.value = ""/);
  assert.doesNotMatch(app, /localStorage\.(?:setItem|getItem)\([^)]*(?:password|username|session|csrf|cookie)/i);
  assert.doesNotMatch(app, /name="password"[^>]+value=/);
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /@media \(max-width: 520px\)/);
});
