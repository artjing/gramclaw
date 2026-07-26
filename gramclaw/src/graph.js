import { loadConfig } from "./config.js";

function graphConfig(overrides = {}) {
  const config = loadConfig();
  const version = overrides.version
    ?? process.env.GRAMCLAW_GRAPH_VERSION
    ?? config.transport?.graphVersion
    ?? "v24.0";
  const baseUrl = overrides.baseUrl
    ?? process.env.GRAMCLAW_GRAPH_BASE_URL
    ?? `https://graph.instagram.com/${version}`;
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    version,
    accessToken: overrides.accessToken ?? process.env.GRAMCLAW_ACCESS_TOKEN ?? "",
    userId: overrides.userId ?? process.env.GRAMCLAW_IG_USER_ID ?? "",
  };
}

export function graphStatus(overrides = {}) {
  const config = graphConfig(overrides);
  return {
    available: Boolean(config.accessToken && config.userId),
    userId: config.userId || null,
    version: config.version,
    baseUrl: config.baseUrl,
    missing: [
      !config.accessToken ? "GRAMCLAW_ACCESS_TOKEN" : null,
      !config.userId ? "GRAMCLAW_IG_USER_ID" : null,
    ].filter(Boolean),
  };
}

async function requestGraph(path, options = {}) {
  const config = graphConfig(options);
  if (!config.accessToken) throw new Error("Missing GRAMCLAW_ACCESS_TOKEN for Instagram Graph transport.");
  const url = new URL(path.startsWith("http") ? path : `${config.baseUrl}/${String(path).replace(/^\//, "")}`);
  const params = { ...(options.params ?? {}), access_token: config.accessToken };
  let body;
  if ((options.method ?? "GET").toUpperCase() === "GET") {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, serialize(value));
    }
  } else {
    body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) body.set(key, serialize(value));
    }
  }
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: body ? { "content-type": "application/x-www-form-urlencoded" } : undefined,
    body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!response.ok || payload.error) {
    const message = payload.error?.message ?? payload.raw ?? `HTTP ${response.status}`;
    throw new Error(`Instagram Graph API: ${message}`);
  }
  return payload;
}

function serialize(value) {
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export async function graphWhoAmI(options = {}) {
  const config = graphConfig(options);
  if (!config.userId) throw new Error("Missing GRAMCLAW_IG_USER_ID.");
  return requestGraph(config.userId, {
    ...options,
    params: { fields: "id,username,name,profile_picture_url,followers_count,follows_count,media_count,biography,website" },
  });
}

export async function graphListMedia(options = {}) {
  const config = graphConfig(options);
  if (!config.userId) throw new Error("Missing GRAMCLAW_IG_USER_ID.");
  const limit = Number(options.limit ?? 100);
  const all = [];
  let next = `${config.userId}/media`;
  let pages = 0;
  while (next && all.length < limit && pages < Number(options.maxPages ?? 10)) {
    const payload = await requestGraph(next, {
      ...options,
      params: next.startsWith("http")
        ? {}
        : {
            fields: "id,caption,media_type,media_product_type,media_url,permalink,thumbnail_url,timestamp,username,like_count,comments_count,children{id,media_type,media_url,thumbnail_url}",
            limit: Math.min(100, limit - all.length),
          },
    });
    all.push(...(payload.data ?? []));
    next = payload.paging?.next ?? null;
    pages += 1;
  }
  return { items: all.slice(0, limit), pages, next };
}

export async function graphListComments(mediaId, options = {}) {
  const limit = Number(options.limit ?? 100);
  return requestGraph(`${mediaId}/comments`, {
    ...options,
    params: {
      fields: "id,text,timestamp,username,from,like_count,replies{id,text,timestamp,username,from,like_count}",
      limit: Math.min(limit, 100),
    },
  });
}

export async function graphPublish(input, options = {}) {
  const config = graphConfig(options);
  if (!config.userId) throw new Error("Missing GRAMCLAW_IG_USER_ID.");
  const type = String(input.type ?? "post").toLowerCase();
  const mediaUrls = Array.isArray(input.mediaUrls) ? input.mediaUrls.filter(Boolean) : [input.mediaUrl].filter(Boolean);
  if (!mediaUrls.length) throw new Error("Publishing requires at least one public media URL.");
  let creationId;
  if (type === "carousel" || mediaUrls.length > 1) {
    const children = [];
    for (const url of mediaUrls) {
      const isVideo = /\.(mp4|mov|m4v)(?:$|\?)/i.test(url);
      const child = await requestGraph(`${config.userId}/media`, {
        ...options,
        method: "POST",
        params: {
          [isVideo ? "video_url" : "image_url"]: url,
          ...(isVideo ? { media_type: "VIDEO" } : {}),
          is_carousel_item: true,
        },
      });
      await waitForContainer(child.id, options);
      children.push(child.id);
    }
    const container = await requestGraph(`${config.userId}/media`, {
      ...options,
      method: "POST",
      params: {
        media_type: "CAROUSEL",
        children,
        caption: input.caption ?? "",
      },
    });
    creationId = container.id;
  } else {
    const url = mediaUrls[0];
    const isVideo = /\.(mp4|mov|m4v)(?:$|\?)/i.test(url) || ["reel", "story-video", "video"].includes(type);
    const params = {
      [isVideo ? "video_url" : "image_url"]: url,
      caption: input.caption ?? "",
    };
    if (type === "reel") {
      params.media_type = "REELS";
      if (input.shareToFeed !== false) params.share_to_feed = true;
      if (input.coverUrl) params.cover_url = input.coverUrl;
    } else if (type === "story" || type === "story-video") {
      params.media_type = "STORIES";
    } else if (isVideo) {
      params.media_type = "VIDEO";
    }
    if (input.altText && !isVideo) params.alt_text = input.altText;
    const container = await requestGraph(`${config.userId}/media`, {
      ...options,
      method: "POST",
      params,
    });
    creationId = container.id;
  }
  await waitForContainer(creationId, options);
  const published = await requestGraph(`${config.userId}/media_publish`, {
    ...options,
    method: "POST",
    params: { creation_id: creationId },
  });
  return { ok: true, transport: "graph", type, creationId, mediaId: published.id };
}

async function waitForContainer(containerId, options = {}) {
  const maxAttempts = Number(options.pollAttempts ?? 40);
  const delayMs = Number(options.pollDelayMs ?? 1500);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const status = await requestGraph(containerId, {
      ...options,
      params: { fields: "status_code,status" },
    });
    const code = String(status.status_code ?? "").toUpperCase();
    if (["FINISHED", "PUBLISHED"].includes(code)) return status;
    if (["ERROR", "EXPIRED"].includes(code)) {
      throw new Error(`Instagram media container ${containerId} failed: ${status.status ?? code}`);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Instagram media container ${containerId} did not finish in time.`);
}

export async function graphComment(mediaId, text, options = {}) {
  return requestGraph(`${mediaId}/comments`, {
    ...options,
    method: "POST",
    params: { message: text },
  });
}

export async function graphReplyToComment(commentId, text, options = {}) {
  return requestGraph(`${commentId}/replies`, {
    ...options,
    method: "POST",
    params: { message: text },
  });
}

export async function graphDeleteComment(commentId, options = {}) {
  return requestGraph(commentId, { ...options, method: "DELETE" });
}

export async function graphSendMessage(recipientId, text, options = {}) {
  const config = graphConfig(options);
  if (!config.userId) throw new Error("Missing GRAMCLAW_IG_USER_ID.");
  return requestGraph(`${config.userId}/messages`, {
    ...options,
    method: "POST",
    params: {
      recipient: { id: recipientId },
      message: { text },
    },
  });
}
