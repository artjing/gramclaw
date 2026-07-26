import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { ensureDirs } from "./config.js";
import { getDb } from "./db.js";
import { graphComment, graphPublish, graphSendMessage } from "./graph.js";
import { runWebAction, syncLive, uploadWebPhoto } from "./live.js";
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
  getDb({ seedDemo: Boolean(options.demo) });
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
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

async function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (!authorize(request, url)) {
    sendJson(response, 401, { ok: false, error: "Unauthorized" });
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    await handleApi(request, response, url);
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

async function handleApi(request, response, url) {
  const db = getDb();
  const method = request.method ?? "GET";
  const segments = url.pathname.split("/").filter(Boolean).slice(1);
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
  response.writeHead(200, {
    "content-type": mimeType(path),
    "content-length": statSync(path).size,
    "cache-control": extname(path) === ".html" ? "no-cache" : "public, max-age=3600",
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
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1_000_000) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
  return ["127.0.0.1", "localhost", "::1"].includes(host);
}

function openUrl(url) {
  const command = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: "ignore" });
  child.unref();
}
