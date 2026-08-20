import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { launchWebviewLogin } from "./webview-login.js";
import { ensureDirs } from "./config.js";
import { getDb } from "./db.js";
import { findArchives, importArchive } from "./archive.js";
import {
  getAnalysisStatus,
  resumeAnalysis,
  retryFailedAnalysis,
  startAnalysis,
} from "./analysis.js";
import { graphComment, graphPublish, graphSendMessage } from "./graph.js";
import { authStatus, connectBrowserSession, INSTAGRAM_LOGIN_URL, runWebAction, syncLive, uploadWebPhoto } from "./live.js";
import {
  completeInstagramLogin,
  logoutInstagramSession,
  startInstagramLogin,
  verifyInstagramSession,
} from "./instagram-auth.js";
import {
  addBoardItems,
  addPostsToCollection,
  createBoard,
  createLibraryCollection,
  createTag,
  getBoard,
  getLibraryOverview,
  listBoards,
  listDuplicateGroups,
  organizeLibrary,
  removeBoardItem,
  removePostsFromCollection,
  tagPosts,
  updateBoard,
  updateBoardItem,
  visualSearch,
} from "./library.js";
import {
  getInbox,
  getInsights,
  getPost,
  getProfile,
  getStatus,
  getThread,
  graphQuery,
  listPosts,
  listProfiles,
  listThreads,
  searchComments,
  searchDms,
} from "./queries.js";

const WEB_ROOT = fileURLToPath(new URL("../web", import.meta.url));

export async function serve(options = {}) {
  const host = options.host ?? process.env.GRAMCLAW_HOST ?? "127.0.0.1";
  const port = Number(options.port ?? process.env.GRAMCLAW_PORT ?? 4667);
  if (!isLoopback(host) && process.env.GRAMCLAW_ALLOW_REMOTE_WEB !== "1") {
    throw new Error("Remote web access is disabled. Bind to 127.0.0.1 or set GRAMCLAW_ALLOW_REMOTE_WEB=1.");
  }
  const db = getDb({ seedDemo: Boolean(options.demo) });
  resumeAnalysis({ db });
  const authContext = createAuthContext({ host, options });
  const server = createServer((request, response) => {
    handleRequest(request, response, authContext).catch((error) => {
      const authRequest = String(request.url ?? "").startsWith("/api/auth/");
      sendJson(response, Number(error?.status ?? 500), {
        ok: false,
        ...(authRequest
          ? {
              code: error?.code ?? "protocol_error",
              error: error?.safeMessage ?? "The authentication request could not be completed.",
            }
          : { error: error instanceof Error ? error.message : String(error) }),
      });
    });
  });
  server.once("close", () => authContext.cleanup());
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolvePromise);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${actualPort}`;
  if (options.open) openUrl(url);
  return { server, url, host, port: actualPort };
}

async function handleRequest(request, response, context) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (!authorize(request, url)) {
    sendJson(response, 401, { ok: false, error: "Unauthorized" });
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    await handleApi(request, response, url, context);
    return;
  }
  if (url.pathname.startsWith("/media/")) {
    serveMedia(response, decodeURIComponent(url.pathname.slice("/media/".length)));
    return;
  }
  serveStatic(response, url.pathname);
}

function authorize(request, url) {
  const token = process.env.GRAMCLAW_WEB_TOKEN;
  if (!token) return true;
  return request.headers["x-gramclaw-token"] === token
    || url.searchParams.get("token") === token
    || parseCookies(request.headers.cookie ?? "").gramclaw_token === token;
}

async function handleApi(request, response, url, context) {
  const db = getDb();
  const method = request.method ?? "GET";
  const segments = url.pathname.split("/").filter(Boolean).slice(1);
  if (segments[0] === "auth") {
    await handleAuthApi(request, response, method, segments.slice(1), context);
    return;
  }
  if (method === "GET" && segments[0] === "archive" && segments[1] === "find") {
    sendJson(response, 200, { items: findArchives() });
    return;
  }
  if (method === "POST" && segments[0] === "archive" && segments[1] === "import") {
    const body = await readBody(request);
    const archivePath = String(body.path ?? "").trim();
    if (!archivePath) {
      sendJson(response, 400, { ok: false, error: "Archive path is required." });
      return;
    }
    const result = await importArchive(archivePath, {
      select: body.select,
      restore: Boolean(body.restore),
    });
    sendJson(response, 200, result);
    return;
  }
  if (method === "GET" && segments[0] === "status") {
    sendJson(response, 200, getStatus(db));
    return;
  }
  if (method === "GET" && segments[0] === "posts" && segments.length === 1) {
    sendJson(response, 200, listPosts(db, {
      query: url.searchParams.get("q") || undefined,
      kind: url.searchParams.get("kind") || undefined,
      collection: url.searchParams.get("collection") || undefined,
      own: url.searchParams.get("own") === "1",
      limit: url.searchParams.get("limit"),
      offset: url.searchParams.get("offset"),
    }));
    return;
  }
  if (method === "GET" && segments[0] === "posts" && segments[1]) {
    const post = getPost(db, decodeURIComponent(segments[1]));
    sendJson(response, post ? 200 : 404, post ?? { ok: false, error: "Post not found" });
    return;
  }
  if (method === "GET" && segments[0] === "threads" && segments.length === 1) {
    sendJson(response, 200, { items: listThreads(db, {
      query: url.searchParams.get("q") || undefined,
      needsReply: url.searchParams.get("needsReply") === "1",
      limit: url.searchParams.get("limit"),
    }) });
    return;
  }
  if (method === "GET" && segments[0] === "threads" && segments[1]) {
    const thread = getThread(db, decodeURIComponent(segments[1]));
    sendJson(response, thread ? 200 : 404, thread ?? { ok: false, error: "Thread not found" });
    return;
  }
  if (method === "GET" && segments[0] === "inbox") {
    sendJson(response, 200, { items: getInbox(db, { limit: url.searchParams.get("limit") }) });
    return;
  }
  if (method === "GET" && segments[0] === "network") {
    const kind = segments[1] ?? "summary";
    sendJson(response, 200, { kind, data: graphQuery(db, kind, { limit: url.searchParams.get("limit"), since: url.searchParams.get("since") }) });
    return;
  }
  if (method === "GET" && segments[0] === "insights") {
    sendJson(response, 200, getInsights(db));
    return;
  }
  if (method === "GET" && segments[0] === "profiles" && segments.length === 1) {
    sendJson(response, 200, { items: listProfiles(db, {
      query: url.searchParams.get("q") || undefined,
      limit: url.searchParams.get("limit"),
    }) });
    return;
  }
  if (method === "GET" && segments[0] === "profiles" && segments[1]) {
    const profile = getProfile(db, decodeURIComponent(segments[1]));
    sendJson(response, profile ? 200 : 404, profile ?? { ok: false, error: "Profile not found" });
    return;
  }
  if (method === "GET" && segments[0] === "search") {
    const q = url.searchParams.get("q") ?? "";
    const scope = url.searchParams.get("scope") ?? "all";
    sendJson(response, 200, {
      q,
      posts: scope === "all" || scope === "posts" ? listPosts(db, { query: q, limit: 50 }).items : [],
      comments: scope === "all" || scope === "comments" ? searchComments(db, q, { limit: 50 }) : [],
      messages: scope === "all" || scope === "dms" ? searchDms(db, q, { limit: 50 }) : [],
    });
    return;
  }
  if (method === "GET" && segments[0] === "visual-search") {
    sendJson(response, 200, visualSearch(db, url.searchParams.get("q") ?? "", {
      saved: url.searchParams.get("saved") || undefined,
      liked: url.searchParams.get("liked") || undefined,
      since: url.searchParams.get("since") || undefined,
      until: url.searchParams.get("until") || undefined,
      author: url.searchParams.get("author") || undefined,
      color: url.searchParams.get("color") || undefined,
      topic: url.searchParams.get("topic") || undefined,
      kind: url.searchParams.get("kind") || undefined,
      collectionId: url.searchParams.get("collectionId") || undefined,
      unorganized: url.searchParams.get("unorganized") || undefined,
      limit: url.searchParams.get("limit") || undefined,
    }));
    return;
  }
  if (method === "GET" && segments[0] === "analysis" && segments[1] === "status") {
    sendJson(response, 200, getAnalysisStatus(db));
    return;
  }
  if (method === "POST" && segments[0] === "analysis" && segments[1] === "run") {
    const body = await readBody(request);
    sendJson(response, 202, startAnalysis({
      db,
      provider: body.provider,
      force: Boolean(body.force),
      postIds: Array.isArray(body.postIds) ? body.postIds : undefined,
      limit: body.limit,
    }));
    return;
  }
  if (method === "POST" && segments[0] === "analysis" && segments[1] === "retry") {
    const body = await readBody(request);
    const queued = retryFailedAnalysis(db, { provider: body.provider });
    resumeAnalysis({ db });
    sendJson(response, 202, { ok: true, ...queued, status: getAnalysisStatus(db) });
    return;
  }
  if (method === "GET" && segments[0] === "library" && segments.length === 1) {
    sendJson(response, 200, getLibraryOverview(db));
    return;
  }
  if (method === "POST" && segments[0] === "library" && segments[1] === "organize") {
    sendJson(response, 200, organizeLibrary(db));
    return;
  }
  if (method === "GET" && segments[0] === "library" && segments[1] === "duplicates") {
    sendJson(response, 200, { items: listDuplicateGroups(db) });
    return;
  }
  if (method === "POST" && segments[0] === "library" && segments[1] === "collections" && segments.length === 2) {
    sendJson(response, 201, createLibraryCollection(db, await readBody(request)));
    return;
  }
  if (method === "POST" && segments[0] === "library" && segments[1] === "collections" && segments[2] && segments[3] === "items") {
    const body = await readBody(request);
    sendJson(response, 200, addPostsToCollection(db, decodeURIComponent(segments[2]), body.postIds));
    return;
  }
  if (method === "DELETE" && segments[0] === "library" && segments[1] === "collections" && segments[2] && segments[3] === "items") {
    const body = await readBody(request);
    sendJson(response, 200, removePostsFromCollection(db, decodeURIComponent(segments[2]), body.postIds));
    return;
  }
  if (method === "POST" && segments[0] === "library" && segments[1] === "tags" && segments.length === 2) {
    sendJson(response, 201, createTag(db, await readBody(request)));
    return;
  }
  if (method === "POST" && segments[0] === "library" && segments[1] === "tags" && segments[2] && segments[3] === "items") {
    const body = await readBody(request);
    sendJson(response, 200, tagPosts(db, decodeURIComponent(segments[2]), body.postIds));
    return;
  }
  if (method === "GET" && segments[0] === "boards" && segments.length === 1) {
    sendJson(response, 200, { items: listBoards(db) });
    return;
  }
  if (method === "POST" && segments[0] === "boards" && segments.length === 1) {
    sendJson(response, 201, createBoard(db, await readBody(request)));
    return;
  }
  if (method === "GET" && segments[0] === "boards" && segments[1]) {
    const board = getBoard(db, decodeURIComponent(segments[1]));
    sendJson(response, board ? 200 : 404, board ?? { ok: false, error: "Board not found" });
    return;
  }
  if (method === "PATCH" && segments[0] === "boards" && segments[1] && segments.length === 2) {
    sendJson(response, 200, updateBoard(db, decodeURIComponent(segments[1]), await readBody(request)));
    return;
  }
  if (method === "POST" && segments[0] === "boards" && segments[1] && segments[2] === "items" && segments.length === 3) {
    const body = await readBody(request);
    sendJson(response, 200, addBoardItems(db, decodeURIComponent(segments[1]), body.postIds));
    return;
  }
  if (method === "PATCH" && segments[0] === "boards" && segments[1] && segments[2] === "items" && segments[3]) {
    sendJson(response, 200, updateBoardItem(
      db,
      decodeURIComponent(segments[1]),
      decodeURIComponent(segments[3]),
      await readBody(request),
    ));
    return;
  }
  if (method === "DELETE" && segments[0] === "boards" && segments[1] && segments[2] === "items" && segments[3]) {
    sendJson(response, 200, removeBoardItem(db, decodeURIComponent(segments[1]), decodeURIComponent(segments[3])));
    return;
  }
  if (method === "GET" && segments[0] === "actions") {
    sendJson(response, 200, {
      items: db.prepare("select * from action_queue order by created_at desc limit 100").all(),
      liveWritesEnabled: process.env.GRAMCLAW_ENABLE_LIVE_WRITES === "1",
    });
    return;
  }
  if (method === "POST" && segments[0] === "sync") {
    const body = await readBody(request);
    const result = await syncLive(body.stream ?? "posts", { ...body, yes: true });
    sendJson(response, 200, result);
    return;
  }
  if (method === "POST" && segments[0] === "actions") {
    const body = await readBody(request);
    const result = await runWebAction(body.kind, body.target, body, {
      ...body,
      yes: process.env.GRAMCLAW_ENABLE_LIVE_WRITES === "1",
    });
    sendJson(response, 200, result);
    return;
  }
  if (method === "POST" && segments[0] === "publish") {
    const body = await readBody(request);
    const result = body.transport === "cookie"
      ? await uploadWebPhoto(body, { ...body, yes: process.env.GRAMCLAW_ENABLE_LIVE_WRITES === "1" })
      : await graphPublish(body, body);
    sendJson(response, 200, result);
    return;
  }
  if (method === "POST" && segments[0] === "graph-comment") {
    const body = await readBody(request);
    sendJson(response, 200, await graphComment(body.mediaId, body.text, body));
    return;
  }
  if (method === "POST" && segments[0] === "graph-message") {
    const body = await readBody(request);
    sendJson(response, 200, await graphSendMessage(body.recipientId, body.text, body));
    return;
  }
  sendJson(response, 404, { ok: false, error: "API route not found" });
}

function serveMedia(response, id) {
  const db = getDb();
  const row = db.prepare("select * from media where id=?").get(id);
  if (!row?.local_path || !existsSync(row.local_path)) {
    sendJson(response, 404, { ok: false, error: "Media not cached" });
    return;
  }
  const mediaRoot = resolve(ensureDirs().mediaDir);
  const path = resolve(row.local_path);
  if (!path.startsWith(`${mediaRoot}/`)) {
    sendJson(response, 403, { ok: false, error: "Media path is outside Gramclaw storage" });
    return;
  }
  response.writeHead(200, {
    "content-type": mimeType(path),
    "content-length": statSync(path).size,
    "cache-control": "private, max-age=3600",
  });
  createReadStream(path).pipe(response);
}

function serveStatic(response, pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let path = resolve(WEB_ROOT, relativePath);
  if (!path.startsWith(`${resolve(WEB_ROOT)}/`) || !existsSync(path) || statSync(path).isDirectory()) {
    path = join(WEB_ROOT, "index.html");
  }
  const ext = extname(path).toLowerCase();
  const noCache = [".html", ".js", ".css"].includes(ext);
  response.writeHead(200, {
    "content-type": mimeType(path),
    "content-length": statSync(path).size,
    "cache-control": noCache ? "no-store" : "public, max-age=3600",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
  });
  createReadStream(path).pipe(response);
}

function mimeType(path) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
  }[extname(path).toLowerCase()] ?? "application/octet-stream";
}

async function readBody(request) {
  return readBodyWithOptions(request);
}

async function readBodyWithOptions(request, options = {}) {
  if (options.requireJson && !String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw authHttpError(415, "invalid_request", "Authentication requests must use JSON.");
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > Number(options.limit ?? 1_000_000)) {
      throw options.requireJson
        ? authHttpError(413, "invalid_request", "Authentication request body is too large.")
        : new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (options.requireJson) throw authHttpError(400, "invalid_request", "Authentication request JSON is invalid.");
    throw error;
  }
}

function sendJson(response, status, payload) {
  if (response.headersSent) return;
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function parseCookies(header) {
  return Object.fromEntries(header.split(";").map((part) => {
    const [key, ...rest] = part.trim().split("=");
    return [key, rest.join("=")];
  }).filter(([key]) => key));
}

function isLoopback(host) {
  const normalized = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  return ["127.0.0.1", "localhost", "::1"].includes(normalized);
}

function createAuthContext({ host, options }) {
  const api = options.instagramAuth ?? {
    completeLogin: completeInstagramLogin,
    connectBrowser: connectBrowserSession,
    logout: logoutInstagramSession,
    startLogin: startInstagramLogin,
    status: authStatus,
    verify: verifyInstagramSession,
  };
  const openBrowser = options.openUrl ?? (async (url, opts = {}) => {
    if (opts.app === "GramclawLogin") {
      return launchWebviewLogin({ url });
    }
    openUrl(url, opts);
  });
  const attempts = new Map();
  const starts = [];
  const attemptTimeoutMs = Number(options.authAttemptTimeoutMs ?? 600_000);
  const rateWindowMs = Number(options.authRateWindowMs ?? 300_000);
  const rateLimit = Number(options.authRateLimit ?? 3);
  let starting = false;
  return {
    api,
    attempts,
    attemptTimeoutMs,
    host,
    openBrowser,
    rateLimit,
    rateWindowMs,
    starts,
    get starting() {
      return starting;
    },
    set starting(value) {
      starting = value;
    },
    cleanup() {
      for (const record of attempts.values()) record.attempt.cancel();
      attempts.clear();
    },
  };
}

async function handleAuthApi(request, response, method, segments, context) {
  validateAuthBoundary(request, method, context);
  if (method === "GET" && segments[0] === "status" && segments.length === 1) {
    const status = await context.api.status();
    sendJson(response, 200, {
      ok: true,
      ...(status?.direct ? status : { direct: status }),
    });
    return;
  }
  if (method === "POST" && segments[0] === "browser" && segments[1] === "open" && segments.length === 2) {
    if (!isLoopback(context.host)) {
      throw authHttpError(403, "remote_login_disabled", "Browser sign-in is available only on the loopback listener.");
    }
    await readBodyWithOptions(request, { limit: 1_024, requireJson: true });
    let launched;
    try {
      launched = await context.openBrowser(INSTAGRAM_LOGIN_URL, { app: "GramclawLogin" });
    } catch (error) {
      throw authHttpError(
        400,
        error?.code === "cancelled" ? "cancelled" : "browser_session_unavailable",
        error?.code === "cancelled"
          ? "Sign-in was cancelled."
          : (error instanceof Error ? error.message : "Could not open the Gramclaw login window."),
      );
    }
    if (launched && typeof launched === "object" && launched.cancelled) {
      throw authHttpError(400, "cancelled", "Sign-in was cancelled.");
    }
    if (launched && typeof launched === "object" && launched.cookies?.length) {
      try {
        sendJson(response, 200, {
          ok: true,
          url: INSTAGRAM_LOGIN_URL,
          ...(await context.api.connectBrowser({ cookies: launched.cookies })),
        });
        return;
      } catch (error) {
        throw authHttpError(
          400,
          error?.code === "browser_session_unavailable" ? error.code : "browser_session_unavailable",
          error?.code === "browser_session_unavailable"
            ? error.message
            : "The Gramclaw login window signed in, but Instagram rejected that session when Gramclaw reused it. Archive import remains the reliable path.",
        );
      }
    }
    sendJson(response, 200, { ok: true, url: INSTAGRAM_LOGIN_URL });
    return;
  }
  if (method === "POST" && segments[0] === "browser" && segments[1] === "connect" && segments.length === 2) {
    if (!isLoopback(context.host)) {
      throw authHttpError(403, "remote_login_disabled", "Browser sign-in is available only on the loopback listener.");
    }
    await readBodyWithOptions(request, { limit: 1_024, requireJson: true });
    try {
      sendJson(response, 200, await context.api.connectBrowser());
    } catch (error) {
      throw authHttpError(
        400,
        error?.code === "browser_session_unavailable" ? error.code : "browser_session_unavailable",
        error?.code === "browser_session_unavailable"
          ? error.message
          : "No signed-in Instagram browser session was found. Tap Open Instagram, sign in in the Gramclaw login window, then continue.",
      );
    }
    return;
  }
  if (method === "POST" && segments[0] === "login" && segments.length === 1) {
    if (!isLoopback(context.host)) {
      throw authHttpError(403, "remote_login_disabled", "Direct password sign-in is available only on the loopback listener.");
    }
    pruneAuthStarts(context);
    if (context.starts.length >= context.rateLimit) {
      throw authHttpError(429, "throttled", "Too many sign-in attempts. Stop and wait before trying again.");
    }
    if (context.starting || activeAttempt(context)) {
      throw authHttpError(409, "attempt_active", "Another Instagram sign-in attempt is already active.");
    }
    context.starts.push(Date.now());
    context.starting = true;
    let attempt;
    let password;
    let clientGone = false;
    const abandonAttempt = () => {
      clientGone = true;
      if (attempt) {
        attempt.cancel();
        context.attempts.delete(attempt.id);
      }
    };
    request.once("aborted", abandonAttempt);
    response.once("close", () => {
      if (!response.writableEnded) abandonAttempt();
    });
    try {
      const body = await readBodyWithOptions(request, { limit: 16_384, requireJson: true });
      if (body.acceptPrivateApiRisk !== true) {
        throw authHttpError(400, "risk_not_accepted", "Accept the private API risk before connecting.");
      }
      const username = String(body.username ?? "").trim().replace(/^@/, "");
      password = body.password;
      delete body.password;
      if (!username || typeof password !== "string" || !password) {
        throw authHttpError(400, "invalid_request", "Username and password are required.");
      }
      attempt = await context.api.startLogin({ username, password });
    } finally {
      password = undefined;
      context.starting = false;
    }
    if (clientGone) {
      attempt.cancel();
      return;
    }
    const record = {
      attempt,
      expiresAt: Date.now() + context.attemptTimeoutMs,
    };
    context.attempts.set(attempt.id, record);
    const message = await attempt.nextMessage({ actionable: true });
    await sendAttemptMessage(response, context, record, message);
    return;
  }
  if (
    method === "POST"
    && segments[0] === "login"
    && segments[1]
    && segments[2] === "respond"
    && segments.length === 3
  ) {
    const record = getAttempt(context, segments[1]);
    response.once("close", () => {
      if (!response.writableEnded) {
        record.attempt.cancel();
        context.attempts.delete(record.attempt.id);
      }
    });
    const body = await readBodyWithOptions(request, { limit: 4_096, requireJson: true });
    let value = body.value;
    const promptId = String(body.promptId ?? "");
    delete body.value;
    if (!promptId || typeof value !== "string") {
      value = undefined;
      throw authHttpError(400, "invalid_request", "A matching prompt response is required.");
    }
    record.attempt.respond(promptId, value);
    value = undefined;
    record.expiresAt = Date.now() + context.attemptTimeoutMs;
    const message = await record.attempt.nextMessage({ actionable: true });
    await sendAttemptMessage(response, context, record, message);
    return;
  }
  if (
    method === "DELETE"
    && segments[0] === "login"
    && segments[1]
    && segments.length === 2
  ) {
    const record = getAttempt(context, segments[1]);
    record.attempt.cancel();
    context.attempts.delete(record.attempt.id);
    sendJson(response, 200, { ok: true, cancelled: true });
    return;
  }
  if (method === "POST" && segments[0] === "verify" && segments.length === 1) {
    await readBodyWithOptions(request, { limit: 1_024, requireJson: true });
    sendJson(response, 200, await context.api.verify());
    return;
  }
  if (method === "POST" && segments[0] === "logout" && segments.length === 1) {
    await readBodyWithOptions(request, { limit: 1_024, requireJson: true });
    sendJson(response, 200, {
      ...await context.api.logout(),
      message: "Disconnected on this machine. Other Instagram devices remain signed in.",
    });
    return;
  }
  throw authHttpError(404, "not_found", "Authentication route not found.");
}

async function sendAttemptMessage(response, context, record, message) {
  if (message.type === "prompt") {
    sendJson(response, 202, {
      ok: true,
      attemptId: record.attempt.id,
      state: {
        two_factor: "needs_2fa",
        challenge_code: "needs_challenge_code",
        manual_approval: "needs_manual_approval",
      }[message.kind] ?? "needs_manual_approval",
      prompt: {
        id: message.id,
        kind: message.kind,
        channel: message.channel,
        maskedDestination: message.maskedDestination,
        ...(message.instruction ? { instruction: message.instruction } : {}),
      },
    });
    return;
  }
  context.attempts.delete(record.attempt.id);
  if (message.type === "error") {
    throw authHttpError(
      message.code === "throttled" ? 429 : 400,
      message.code,
      message.message,
    );
  }
  const result = await context.api.completeLogin(message);
  sendJson(response, 200, result);
}

function validateAuthBoundary(request, method, context) {
  const hostHeader = String(request.headers.host ?? "");
  let requestHost;
  try {
    requestHost = new URL(`http://${hostHeader}`).hostname;
  } catch {
    throw authHttpError(403, "invalid_origin", "Authentication request host is invalid.");
  }
  const hostMatches = requestHost === context.host
    || (isLoopback(requestHost) && isLoopback(context.host));
  if (!hostHeader || !hostMatches) {
    throw authHttpError(403, "invalid_origin", "Authentication request host is not allowed.");
  }
  if (method !== "GET") {
    const originHeader = String(request.headers.origin ?? "");
    let origin;
    try {
      origin = new URL(originHeader);
    } catch {
      throw authHttpError(403, "invalid_origin", "Authentication request origin is required.");
    }
    if (origin.protocol !== "http:" || origin.host !== hostHeader) {
      throw authHttpError(403, "invalid_origin", "Authentication request origin is not allowed.");
    }
  }
}

function activeAttempt(context) {
  for (const [id, record] of context.attempts) {
    if (record.expiresAt <= Date.now()) {
      record.attempt.cancel();
      context.attempts.delete(id);
      continue;
    }
    return record;
  }
  return null;
}

function getAttempt(context, id) {
  const record = context.attempts.get(String(id));
  if (!record || record.expiresAt <= Date.now()) {
    if (record) record.attempt.cancel();
    context.attempts.delete(String(id));
    throw authHttpError(404, "attempt_not_found", "Sign-in attempt was not found or has expired.");
  }
  return record;
}

function pruneAuthStarts(context) {
  const cutoff = Date.now() - context.rateWindowMs;
  while (context.starts[0] < cutoff) context.starts.shift();
}

function authHttpError(status, code, safeMessage) {
  const error = new Error(safeMessage);
  error.status = status;
  error.code = code;
  error.safeMessage = safeMessage;
  return error;
}

function openUrl(url, options = {}) {
  const preferChrome = options.app === "Google Chrome"
    && process.platform === "darwin"
    && existsSync("/Applications/Google Chrome.app");
  const command = process.platform === "darwin"
    ? (preferChrome ? ["open", ["-a", "Google Chrome", url]] : ["open", [url]])
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: "ignore" });
  child.unref();
}
