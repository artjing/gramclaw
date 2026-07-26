import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  clearInstagramAuthMetadata,
  getInstagramAuthMetadata,
  setInstagramAuthMetadata,
} from "./config.js";
import {
  inspectInstagramRuntime,
  prepareInstagramRuntime,
  RuntimeUnavailableError,
} from "./python-runtime.js";

export const PRIVATE_API_WARNING = "Direct sign-in uses Instagram's unofficial private API. Instagram may challenge, restrict, or ban accounts that use it; continue only with an account you control.";
export const DIRECT_CREDENTIAL_SOURCE = "instagrapi-session";
export const COOKIE_ALLOWLIST = [
  "sessionid",
  "csrftoken",
  "ds_user_id",
  "mid",
  "ig_did",
  "rur",
  "datr",
  "dpr",
];

const SAFE_ERRORS = {
  bad_credentials: "Instagram rejected the username or password.",
  two_factor_required: "Instagram requires a two-factor code.",
  challenge_code_required: "Instagram requires a challenge code.",
  manual_verification_required: "Finish the Instagram checkpoint in the official app or website, then reconnect.",
  throttled: "Instagram asked Gramclaw to stop and wait before trying again.",
  session_expired: "The saved Instagram session is unavailable. Run `gramclaw login` to reconnect.",
  runtime_unavailable: "Python 3.10+ and the secure sign-in runtime are required.",
  keyring_unavailable: "A secure system credential store is unavailable.",
  web_cookie_bridge_unavailable: "The saved session could not be verified with Gramclaw's existing web transport.",
  protocol_error: "The secure sign-in protocol failed.",
  cancelled: "Sign-in was cancelled.",
};

export class InstagramAuthError extends Error {
  constructor(code, message) {
    const safeCode = SAFE_ERRORS[code] ? code : "protocol_error";
    super(message && SAFE_ERRORS[safeCode] === message ? message : SAFE_ERRORS[safeCode]);
    this.name = "InstagramAuthError";
    this.code = safeCode;
  }
}

export function redactAuthValue(value) {
  if (Array.isArray(value)) return value.map(redactAuthValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /pass|session|csrf|cookie|authorization|token|challenge|phone|email/i.test(key)
        ? "[redacted]"
        : redactAuthValue(item),
    ]));
  }
  if (typeof value === "string") {
    return value
      .replace(/\b[^\s@]*\*+[^\s@]*@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
      .replace(/\+?\d[\d ()-]{7,}\d/g, "[redacted-phone]");
  }
  return value;
}

export function sidecarEnvironment(extra = {}) {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ];
  const env = Object.fromEntries(
    allowed.filter((name) => process.env[name]).map((name) => [name, process.env[name]]),
  );
  for (const [key, value] of Object.entries(extra)) {
    if (!/pass|session|csrf|cookie|authorization|token/i.test(key) && value !== undefined) {
      env[key] = String(value);
    }
  }
  env.PYTHONUTF8 = "1";
  env.PYTHONUNBUFFERED = "1";
  return env;
}

export function sidecarInvocation(runtime) {
  return {
    command: runtime.pythonPath,
    args: [runtime.sidecarPath],
    options: {
      env: sidecarEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  };
}

export class InstagramLoginAttempt {
  constructor(runtime, options = {}) {
    this.id = randomBytes(24).toString("base64url");
    this.runtime = runtime;
    this.timeoutMs = Number(options.timeoutMs ?? 600_000);
    this.queue = [];
    this.waiters = [];
    this.buffer = "";
    this.currentPrompt = null;
    this.terminal = false;
    this.child = spawnSidecar(runtime, options);
    this.child.stdout.on("data", (chunk) => this.#receive(chunk));
    this.child.stderr.on("data", () => {
      // Third-party stderr is never forwarded or attached to errors.
    });
    this.child.once("error", () => this.#fail("protocol_error"));
    this.child.once("exit", (code) => {
      if (!this.terminal && code !== 0) this.#fail("protocol_error");
      else if (!this.terminal) this.#fail("protocol_error");
    });
    this.#touch();
  }

  start(username, password, credentialId) {
    if (!username || !password) throw new InstagramAuthError("protocol_error");
    this.#send({
      v: 1,
      op: "login",
      username: String(username).replace(/^@/, ""),
      password,
      ...(credentialId ? { credentialId } : {}),
    });
    return this;
  }

  async nextMessage(options = {}) {
    while (true) {
      const message = this.queue.shift() ?? await new Promise((resolvePromise) => {
        this.waiters.push(resolvePromise);
      });
      if (!options.actionable || message.type !== "state") return message;
      options.onState?.(message.state);
    }
  }

  respond(promptId, value) {
    if (
      this.terminal
      || !this.currentPrompt
      || promptId !== this.currentPrompt.id
      || typeof value !== "string"
    ) {
      throw new InstagramAuthError("protocol_error");
    }
    this.currentPrompt = null;
    this.#send({ v: 1, op: "respond", promptId, value });
    this.#touch();
  }

  cancel() {
    if (this.terminal) return;
    try {
      this.#send({ v: 1, op: "cancel" });
    } catch {
      // The child may already be exiting.
    }
    this.terminal = true;
    clearTimeout(this.timer);
    this.child.kill();
    this.#publish({ v: 1, type: "error", ok: false, code: "cancelled", message: SAFE_ERRORS.cancelled });
  }

  #receive(chunk) {
    if (this.terminal) return;
    this.buffer += String(chunk);
    if (this.buffer.length > 256_000) return this.#fail("protocol_error");
    while (this.buffer.includes("\n")) {
      const index = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#fail("protocol_error");
        return;
      }
      if (!validProtocolMessage(message)) {
        this.#fail("protocol_error");
        return;
      }
      this.#touch();
      if (message.type === "prompt") this.currentPrompt = message;
      if (message.type === "result" || message.type === "error") {
        this.terminal = true;
        clearTimeout(this.timer);
        this.child.stdin.end();
      }
      this.#publish(sanitizeProtocolMessage(message));
    }
  }

  #send(message) {
    if (!this.child.stdin.writable) throw new InstagramAuthError("protocol_error");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #touch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.#fail("protocol_error"), this.timeoutMs);
    this.timer.unref?.();
  }

  #fail(code) {
    if (this.terminal) return;
    this.terminal = true;
    clearTimeout(this.timer);
    this.child.kill();
    this.#publish({
      v: 1,
      type: "error",
      ok: false,
      code,
      message: SAFE_ERRORS[code] ?? SAFE_ERRORS.protocol_error,
    });
  }

  #publish(message) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(message);
    else this.queue.push(message);
  }
}

export async function prepareInstagramAuth(options = {}) {
  let runtime;
  try {
    runtime = await prepareInstagramRuntime(options);
  } catch (error) {
    if (error instanceof RuntimeUnavailableError) {
      throw new InstagramAuthError("runtime_unavailable");
    }
    throw error;
  }
  await runSidecarOperation("doctor", {}, { ...options, runtime });
  return runtime;
}

export async function startInstagramLogin(options = {}) {
  const runtime = options.runtime ?? await prepareInstagramAuth(options);
  const metadata = getInstagramAuthMetadata();
  return new InstagramLoginAttempt(runtime, options)
    .start(options.username, options.password, metadata?.username === options.username ? metadata.credentialId : "");
}

export async function runSidecarOperation(operation, payload = {}, options = {}) {
  const runtime = options.runtime ?? inspectInstagramRuntime(options);
  const child = spawnSidecar(runtime, options);
  let buffer = "";
  let settled = false;
  return await new Promise((resolvePromise, reject) => {
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      callback(value);
    };
    const fail = (code = "protocol_error") => finish(
      reject,
      new InstagramAuthError(code),
    );
    const timer = setTimeout(() => {
      child.kill();
      fail();
    }, Number(options.timeoutMs ?? 30_000));
    timer.unref?.();
    child.stderr.on("data", () => {
      // Never forward credential-bearing dependency diagnostics.
    });
    child.once("error", () => fail());
    child.once("exit", () => {
      if (!settled) fail();
    });
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      if (buffer.length > 256_000) return fail();
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          child.kill();
          return fail();
        }
        if (!validProtocolMessage(message) || message.type === "prompt") {
          child.kill();
          return fail();
        }
        if (message.type === "state") continue;
        if (message.type === "error") {
          return finish(reject, new InstagramAuthError(message.code, message.message));
        }
        return finish(resolvePromise, message);
      }
    });
    child.stdin.write(`${JSON.stringify({ v: 1, op: operation, ...payload })}\n`);
  });
}

export async function directAuthStatus(options = {}) {
  const metadata = getInstagramAuthMetadata();
  const base = {
    configured: Boolean(metadata?.credentialId),
    available: false,
    username: metadata?.username ?? null,
    userId: metadata?.userId ?? null,
    verified: false,
    lastVerifiedAt: metadata?.lastVerifiedAt ?? null,
    source: "system-credential-store",
    warnings: [],
  };
  if (!metadata?.credentialId) return base;
  try {
    const runtime = inspectInstagramRuntime(options);
    const result = await runSidecarOperation(
      "status",
      { credentialId: metadata.credentialId },
      { ...options, runtime },
    );
    return { ...base, available: Boolean(result.available) };
  } catch (error) {
    return {
      ...base,
      warnings: [error instanceof InstagramAuthError ? error.message : SAFE_ERRORS.protocol_error],
    };
  }
}

export async function loadDirectCredentials(options = {}) {
  const metadata = getInstagramAuthMetadata();
  if (!metadata?.credentialId) return null;
  const result = await runSidecarOperation("credentials", {
    credentialId: metadata.credentialId,
  }, options);
  const cookies = Object.fromEntries(
    COOKIE_ALLOWLIST
      .filter((name) => typeof result.credentials?.cookies?.[name] === "string")
      .map((name) => [name, result.credentials.cookies[name]]),
  );
  if (!cookies.sessionid || !cookies.csrftoken) {
    throw new InstagramAuthError("web_cookie_bridge_unavailable");
  }
  return {
    sessionId: cookies.sessionid,
    csrfToken: cookies.csrftoken,
    userId: result.credentials.userId || cookies.ds_user_id || metadata.userId || "",
    cookieHeader: Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join("; "),
    source: DIRECT_CREDENTIAL_SOURCE,
    warnings: [],
  };
}

export async function completeInstagramLogin(sidecarResult, options = {}) {
  const identity = sanitizeIdentity(sidecarResult.identity);
  if (
    !String(sidecarResult.credentialId ?? "").startsWith("ig:")
    || !identity.username
    || !identity.userId
  ) {
    throw new InstagramAuthError("protocol_error");
  }
  const connectedAt = new Date().toISOString();
  saveInstagramMetadata({
    credentialId: sidecarResult.credentialId,
    username: identity.username,
    userId: identity.userId,
    connectedAt,
  });
  await registerConnectedAccount(identity);
  if (options.verifyWeb === false || !sidecarResult.bridgeAvailable) {
    return loginEnvelope(identity, false, sidecarResult.bridgeAvailable
      ? null
      : "web_cookie_bridge_unavailable");
  }
  try {
    const { webWhoAmI } = await import("./live.js");
    const webIdentity = await webWhoAmI();
    const verifiedIdentity = {
      username: webIdentity.username || identity.username,
      userId: webIdentity.id || identity.userId,
      displayName: webIdentity.displayName || identity.displayName,
      avatarUrl: webIdentity.avatarUrl || identity.avatarUrl,
    };
    const lastVerifiedAt = new Date().toISOString();
    saveInstagramMetadata({
      credentialId: sidecarResult.credentialId,
      username: verifiedIdentity.username,
      userId: verifiedIdentity.userId,
      connectedAt,
      lastVerifiedAt,
    });
    await registerConnectedAccount(verifiedIdentity);
    return loginEnvelope(verifiedIdentity, true);
  } catch {
    return loginEnvelope(identity, false, "web_cookie_bridge_unavailable");
  }
}

export async function verifyInstagramSession(options = {}) {
  const metadata = getInstagramAuthMetadata();
  if (!metadata?.credentialId) throw new InstagramAuthError("session_expired");
  const runtime = await prepareInstagramAuth(options);
  const result = await runSidecarOperation("verify", {
    credentialId: metadata.credentialId,
  }, { ...options, runtime });
  return completeInstagramLogin(result, { verifyWeb: options.verifyWeb !== false });
}

export async function logoutInstagramSession(options = {}) {
  const metadata = getInstagramAuthMetadata();
  if (!metadata?.credentialId) {
    clearInstagramMetadata();
    return { ok: true, disconnected: true, deleted: false };
  }
  const runtime = inspectInstagramRuntime(options);
  const result = await runSidecarOperation("delete", {
    credentialId: metadata.credentialId,
  }, { ...options, runtime });
  clearInstagramMetadata();
  return { ok: true, disconnected: true, deleted: Boolean(result.deleted) };
}

export async function mergeDirectCookies(cookies, options = {}) {
  const metadata = getInstagramAuthMetadata();
  if (!metadata?.credentialId) return { ok: false, updated: false };
  const allowed = Object.fromEntries(
    COOKIE_ALLOWLIST.filter((name) => typeof cookies?.[name] === "string" && cookies[name])
      .map((name) => [name, cookies[name]]),
  );
  if (!Object.keys(allowed).length) return { ok: true, updated: false };
  return runSidecarOperation("merge-cookies", {
    credentialId: metadata.credentialId,
    cookies: allowed,
  }, options);
}

function spawnSidecar(runtime, options = {}) {
  const invocation = sidecarInvocation(runtime);
  return (options.spawnFn ?? spawn)(invocation.command, invocation.args, invocation.options);
}

function validProtocolMessage(message) {
  return message
    && typeof message === "object"
    && message.v === 1
    && ["state", "prompt", "result", "error"].includes(message.type);
}

function sanitizeProtocolMessage(message) {
  if (message.type === "error") {
    const code = SAFE_ERRORS[message.code] ? message.code : "protocol_error";
    return { v: 1, type: "error", ok: false, code, message: SAFE_ERRORS[code] };
  }
  if (message.type === "prompt") {
    return {
      v: 1,
      type: "prompt",
      id: String(message.id ?? ""),
      kind: ["two_factor", "challenge_code", "manual_approval"].includes(message.kind)
        ? message.kind
        : "manual_approval",
      channel: typeof message.channel === "string" ? message.channel : null,
      maskedDestination: typeof message.maskedDestination === "string" ? message.maskedDestination : null,
      instruction: typeof message.instruction === "string"
        ? "Approve this login in the official Instagram app, then continue."
        : undefined,
    };
  }
  if (message.type === "result") {
    return {
      v: 1,
      type: "result",
      ok: true,
      identity: sanitizeIdentity(message.identity),
      credentialId: String(message.credentialId ?? ""),
      bridgeAvailable: Boolean(message.bridgeAvailable),
    };
  }
  return message;
}

function sanitizeIdentity(identity = {}) {
  return {
    username: String(identity.username ?? "").replace(/^@/, ""),
    userId: String(identity.userId ?? ""),
    displayName: String(identity.displayName ?? identity.username ?? ""),
    avatarUrl: typeof identity.avatarUrl === "string" ? identity.avatarUrl : null,
  };
}

function saveInstagramMetadata(metadata) {
  setInstagramAuthMetadata(metadata);
}

function clearInstagramMetadata() {
  clearInstagramAuthMetadata();
}

async function registerConnectedAccount(identity) {
  const { ensureAccount, getDb, setDefaultAccount } = await import("./db.js");
  const db = getDb();
  const account = ensureAccount(db, {
    externalUserId: identity.userId,
    username: identity.username,
    displayName: identity.displayName,
    avatarUrl: identity.avatarUrl,
    transport: "cookie",
    isDefault: true,
  });
  setDefaultAccount(db, account.id);
  return account;
}

function loginEnvelope(identity, verified, errorCode = null) {
  return {
    ok: true,
    connected: true,
    username: identity.username,
    userId: identity.userId,
    displayName: identity.displayName,
    avatarUrl: identity.avatarUrl,
    credentialSource: DIRECT_CREDENTIAL_SOURCE,
    verified,
    passwordStored: false,
    ...(errorCode ? { errorCode, message: SAFE_ERRORS[errorCode] } : {}),
    nextSteps: ["gramclaw sync posts --mode cookie --limit 30 --json"],
  };
}
