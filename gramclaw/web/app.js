const state = {
  view: "home",
  status: null,
  query: "",
  theme: localStorage.getItem("gramclaw-theme") || "system",
};

const els = {
  nav: document.querySelector("#nav"),
  title: document.querySelector("#view-title"),
  eyebrow: document.querySelector("#view-eyebrow"),
  content: document.querySelector("#content"),
  summary: document.querySelector("#summary-strip"),
  search: document.querySelector("#search"),
  sync: document.querySelector("#sync-button"),
  inboxCount: document.querySelector("#inbox-count"),
  dialog: document.querySelector("#detail-dialog"),
  dialogContent: document.querySelector("#dialog-content"),
  toast: document.querySelector("#toast"),
};

const viewMeta = {
  home: ["Home", "Personal archive"],
  inbox: ["Inbox", "Priority queue"],
  saved: ["Saved", "Your references"],
  liked: ["Liked", "Things you noticed"],
  stories: ["Stories", "Ephemeral, preserved"],
  dms: ["Messages", "Local conversations"],
  network: ["Network", "Relationship memory"],
  insights: ["Insights", "Patterns, not vanity"],
  search: ["Search", "Across every surface"],
};

init();

async function init() {
  applyTheme();
  bindEvents();
  await refreshStatus();
  await render();
}

function bindEvents() {
  els.nav.addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (!button) return;
    setView(button.dataset.view);
  });
  els.search.addEventListener("input", debounce(() => {
    state.query = els.search.value.trim();
    if (state.query) setView("search");
    else if (state.view === "search") setView("home");
  }, 220));
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      els.search.focus();
    }
    if (event.key === "Escape" && els.dialog.open) els.dialog.close();
  });
  document.querySelector("#theme-toggle").addEventListener("click", () => {
    state.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem("gramclaw-theme", state.theme);
    applyTheme();
  });
  els.sync.addEventListener("click", syncCurrentView);
  els.dialog.querySelector(".dialog-close").addEventListener("click", () => els.dialog.close());
  els.dialog.addEventListener("click", (event) => {
    if (event.target === els.dialog) els.dialog.close();
  });
  els.content.addEventListener("click", handleContentClick);
}

function applyTheme() {
  const dark = state.theme === "dark"
    || (state.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

async function refreshStatus() {
  state.status = await api("/api/status");
  const counts = state.status.counts;
  els.inboxCount.textContent = String(Math.min(99, counts.dmThreads + Math.min(9, counts.comments)));
  els.summary.innerHTML = [
    ["Posts indexed", formatNumber(counts.posts)],
    ["Messages", formatNumber(counts.dmMessages)],
    ["Saved + liked", formatNumber(counts.saved + counts.liked)],
    ["People mapped", formatNumber(counts.profiles)],
  ].map(([label, value]) => `<div class="summary-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
}

async function setView(view) {
  state.view = view;
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  await render();
}

async function render() {
  const [title, eyebrow] = viewMeta[state.view] || viewMeta.home;
  els.title.textContent = title;
  els.eyebrow.textContent = eyebrow;
  els.content.innerHTML = `<div class="loading-state"><div class="loader"></div><p>Reading local SQLite…</p></div>`;
  try {
    if (["home", "saved", "liked", "stories"].includes(state.view)) await renderPosts();
    else if (state.view === "inbox") await renderInbox();
    else if (state.view === "dms") await renderDms();
    else if (state.view === "network") await renderNetwork();
    else if (state.view === "insights") await renderInsights();
    else if (state.view === "search") await renderSearch();
  } catch (error) {
    els.content.innerHTML = emptyState("Something went wrong", error.message);
  }
}

async function renderPosts() {
  const query = new URLSearchParams({ limit: "60" });
  if (state.view === "saved") query.set("collection", "saved");
  if (state.view === "liked") query.set("collection", "liked");
  if (state.view === "stories") query.set("kind", "story");
  const result = await api(`/api/posts?${query}`);
  if (!result.items.length) {
    els.content.innerHTML = emptyState("Nothing here yet", "Import an Instagram JSON export or run a live sync.");
    return;
  }
  els.content.innerHTML = `
    <div class="section-head">
      <h2>${result.items.length} local ${state.view === "home" ? "items" : state.view}</h2>
      <p>Newest first · no network request</p>
    </div>
    <div class="feed-grid">${result.items.map(postCard).join("")}</div>`;
}

function postCard(post) {
  const media = post.media?.[0];
  const mediaMarkup = mediaMarkupFor(media);
  return `
    <article class="post-card" data-post-id="${escapeAttr(post.id)}" tabindex="0">
      <div class="media-tile ${mediaMarkup ? "has-media" : ""}" style="${gradientFor(post.id)}">
        ${mediaMarkup}
        <span class="media-kind">${escapeHtml(post.kind)}</span>
      </div>
      <div class="post-body">
        <div class="post-author">
          ${avatar(post.author_username, post.author_avatar_url)}
          <div><strong>@${escapeHtml(post.author_username)}</strong><span>${relativeTime(post.created_at)}</span></div>
        </div>
        <p class="post-caption">${escapeHtml(post.caption || "Media saved without a caption.")}</p>
        <div class="post-meta"><div><span>♡ ${formatNumber(post.like_count)}</span><span>◌ ${formatNumber(post.comment_count)}</span></div><span class="${post.saved ? "saved" : ""}">${post.saved ? "◆" : "◇"}</span></div>
      </div>
    </article>`;
}

async function renderInbox() {
  const result = await api("/api/inbox?limit=50");
  els.content.innerHTML = `
    <div class="section-head"><h2>Priority-sorted replies</h2><p>Local heuristics · follower context · intent</p></div>
    <div class="list-panel">${result.items.length ? result.items.map((item) => `
      <button class="list-row" data-${item.item_kind === "dm" ? "thread" : "post"}-id="${escapeAttr(item.context_id)}">
        <div class="score">${item.score}</div>
        <div><h3>${escapeHtml(item.author_display_name || item.author_username || "Unknown")} <span class="muted">@${escapeHtml(item.author_username || "")}</span></h3><p>${escapeHtml(item.text)}</p></div>
        <time>${relativeTime(item.created_at)}</time>
      </button>`).join("") : emptyState("Inbox zero", "No imported comments or direct messages.")}</div>`;
}

async function renderDms() {
  const result = await api("/api/threads?limit=100");
  els.content.innerHTML = `
    <div class="section-head"><h2>${result.items.length} conversations</h2><p>Full text is searchable</p></div>
    <div class="list-panel">${result.items.map((thread) => `
      <button class="list-row" data-thread-id="${escapeAttr(thread.id)}">
        ${avatar(thread.title)}
        <div><h3>${escapeHtml(thread.title)}</h3><p>${escapeHtml(thread.last_message || "No text message")}</p></div>
        <time>${relativeTime(thread.last_message_at)}</time>
      </button>`).join("")}</div>`;
}

async function renderNetwork() {
  const [summaryResult, mutualsResult, recentResult] = await Promise.all([
    api("/api/network/summary"),
    api("/api/network/mutuals?limit=12"),
    api("/api/network/events?limit=12"),
  ]);
  const summary = summaryResult.data;
  els.content.innerHTML = `
    <div class="network-grid">
      <article class="metric-card"><h2>Followers</h2><div class="big-number">${formatNumber(summary.followers)}</div><p class="metric-note">${formatNumber(summary.ended30d)} relationship changes recorded in 30 days</p></article>
      <article class="metric-card"><h2>Mutuals</h2><div class="big-number">${formatNumber(summary.mutuals)}</div><p class="metric-note">${formatNumber(summary.nonMutualFollowing)} accounts you follow don’t follow back</p></article>
      <article class="metric-card wide">
        <div class="section-head"><h2>Strongest mutuals</h2><p>Sorted by local follower context</p></div>
        <div class="list-panel">${mutualsResult.data.map((person) => personRow(person)).join("") || emptyState("No mutuals yet", "Import followers and following to build the graph.")}</div>
      </article>
      <article class="metric-card wide">
        <div class="section-head"><h2>Relationship events</h2><p>Append-only history</p></div>
        <div class="list-panel">${recentResult.data.map((event) => `
          <div class="list-row">${avatar(event.username, event.avatar_url)}<div><h3>@${escapeHtml(event.username)}</h3><p>${event.event_type === "started" ? "Relationship appeared" : "Relationship ended"} · ${escapeHtml(event.direction)}</p></div><time>${relativeTime(event.event_at)}</time></div>`).join("") || emptyState("No changes recorded", "A second complete relationship sync will reveal churn.")}</div>
      </article>
    </div>`;
}

function personRow(person) {
  return `<button class="list-row" data-profile-id="${escapeAttr(person.username)}">${avatar(person.username, person.avatar_url)}<div><h3>${escapeHtml(person.display_name)} <span class="muted">@${escapeHtml(person.username)}</span></h3><p>${escapeHtml(person.biography || "No bio saved")}</p></div><time>${formatNumber(person.followers_count)} followers</time></button>`;
}

async function renderInsights() {
  const result = await api("/api/insights");
  const months = result.byMonth;
  const max = Math.max(1, ...months.map((item) => item.posts));
  els.content.innerHTML = `
    <div class="insights-grid">
      <article class="metric-card"><h2>Indexed posts</h2><div class="big-number">${formatNumber(result.posting.posts)}</div><p class="metric-note">${result.posting.avg_likes || 0} average likes · ${result.posting.avg_comments || 0} average comments</p></article>
      <article class="metric-card"><h2>Best response</h2><div class="big-number">${formatNumber(result.posting.top_likes || 0)}</div><p class="metric-note">Highest like count in local history</p></article>
      <article class="metric-card wide"><h2>Posting cadence</h2><div class="bars">${months.map((item) => `<div class="bar" style="--h:${Math.max(8, item.posts / max * 100)}%" data-label="${escapeAttr(`${item.month}: ${item.posts}`)}"></div>`).join("")}</div></article>
      <article class="metric-card"><h2>Recurring language</h2><div class="chips">${result.themes.map((item) => `<span class="chip">${escapeHtml(item.label)} · ${item.count}</span>`).join("")}</div></article>
      <article class="metric-card"><h2>Formats</h2><div class="list-panel">${result.byKind.map((item) => `<div class="list-row"><div class="score">${item.count}</div><div><h3>${escapeHtml(item.kind)}</h3><p>${item.avg_likes || 0} avg likes · ${item.avg_comments || 0} avg comments</p></div></div>`).join("")}</div></article>
    </div>`;
}

async function renderSearch() {
  if (!state.query) {
    els.content.innerHTML = emptyState("Start typing", "Search posts, comments, and direct messages at once.");
    return;
  }
  const result = await api(`/api/search?q=${encodeURIComponent(state.query)}&scope=all`);
  const items = [
    ...result.posts.map((item) => ({ type: "post", id: item.id, title: `@${item.author_username}`, text: item.caption, date: item.created_at })),
    ...result.comments.map((item) => ({ type: "post", id: item.post_id, title: `Comment by @${item.author_username || "unknown"}`, text: item.text, date: item.created_at })),
    ...result.messages.map((item) => ({ type: "thread", id: item.thread_id, title: item.thread_title, text: item.text, date: item.created_at })),
  ].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  els.content.innerHTML = `
    <div class="section-head"><h2>${items.length} matches for “${escapeHtml(state.query)}”</h2><p>FTS5 local search</p></div>
    <div class="list-panel">${items.map((item) => `
      <button class="list-row" data-${item.type}-id="${escapeAttr(item.id)}">
        <div class="score">${item.type === "post" ? "P" : "DM"}</div>
        <div><h3>${escapeHtml(item.title)}</h3><p>${highlight(item.text, state.query)}</p></div>
        <time>${relativeTime(item.date)}</time>
      </button>`).join("") || emptyState("No matches", "Try a broader phrase.")}</div>`;
}

async function handleContentClick(event) {
  const post = event.target.closest("[data-post-id]");
  const thread = event.target.closest("[data-thread-id]");
  const profile = event.target.closest("[data-profile-id]");
  if (post) await openPost(post.dataset.postId);
  else if (thread) await openThread(thread.dataset.threadId);
  else if (profile) await openProfile(profile.dataset.profileId);
}

async function openPost(id) {
  const post = await api(`/api/posts/${encodeURIComponent(id)}`);
  const media = post.media?.[0];
  els.dialogContent.innerHTML = `
    <div class="post-detail">
      <div class="media-tile ${mediaMarkupFor(media) ? "has-media" : ""}" style="${gradientFor(post.id)}">${mediaMarkupFor(media)}</div>
      <div class="post-detail-copy">
        <div class="post-author">${avatar(post.author_username, post.author_avatar_url)}<div><strong>@${escapeHtml(post.author_username)}</strong><span>${relativeTime(post.created_at)}</span></div></div>
        <h2>${escapeHtml(post.kind)}</h2>
        <p>${escapeHtml(post.caption || "No caption")}</p>
        <div class="post-meta"><div><span>♡ ${formatNumber(post.like_count)}</span><span>◌ ${formatNumber(post.comment_count)}</span></div><span>${post.saved ? "◆ saved" : "◇"}</span></div>
        <div class="comments">${post.comments.length ? post.comments.map((comment) => `<div class="comment"><strong>@${escapeHtml(comment.author_username || "unknown")}</strong><p>${escapeHtml(comment.text)}</p></div>`).join("") : "<div class='comment'><p>No comments cached.</p></div>"}</div>
      </div>
    </div>`;
  els.dialog.showModal();
}

async function openThread(id) {
  const thread = await api(`/api/threads/${encodeURIComponent(id)}`);
  els.dialogContent.innerHTML = `
    <div class="post-detail-copy">
      <p class="eyebrow">Direct messages</p><h2>${escapeHtml(thread.title)}</h2>
      <div class="comments">${thread.messages.map((message) => `<div class="comment"><strong>${escapeHtml(message.sender_display_name || message.sender_username || message.direction)}</strong><p>${escapeHtml(message.text)}</p><time>${relativeTime(message.created_at)}</time></div>`).join("")}</div>
    </div>`;
  els.dialog.showModal();
}

async function openProfile(id) {
  const profile = await api(`/api/profiles/${encodeURIComponent(id)}`);
  els.dialogContent.innerHTML = `
    <div class="post-detail-copy">
      <div class="post-author">${avatar(profile.username, profile.avatar_url)}<div><strong>${escapeHtml(profile.display_name)}</strong><span>@${escapeHtml(profile.username)}</span></div></div>
      <h2>${formatNumber(profile.followers_count)} followers</h2>
      <p>${escapeHtml(profile.biography || "No bio cached.")}</p>
      <div class="chips"><span class="chip">${profile.relationship.followsYou ? "Follows you" : "Doesn’t follow you"}</span><span class="chip">${profile.relationship.youFollow ? "You follow" : "Not following"}</span></div>
    </div>`;
  els.dialog.showModal();
}

async function syncCurrentView() {
  const stream = {
    home: "timeline", saved: "saved", liked: "liked", dms: "dms",
    network: "followers", insights: "posts", inbox: "comments", stories: "posts",
  }[state.view] || "posts";
  els.sync.classList.add("loading");
  els.sync.disabled = true;
  try {
    const result = await api("/api/sync", { method: "POST", body: JSON.stringify({ stream, limit: 100 }) });
    toast(`Synced ${formatNumber(Object.values(result.counts || {}).reduce((sum, value) => sum + Number(value || 0), 0))} records`);
    await refreshStatus();
    await render();
  } catch (error) {
    toast(error.message);
  } finally {
    els.sync.classList.remove("loading");
    els.sync.disabled = false;
  }
}

function mediaMarkupFor(media) {
  if (!media) return "";
  const src = media.local_path ? `/media/${encodeURIComponent(media.id)}` : media.remote_url;
  if (!src) return "";
  if (media.media_type === "video") return `<video src="${escapeAttr(src)}" muted playsinline preload="metadata"></video>`;
  return `<img src="${escapeAttr(src)}" alt="${escapeAttr(media.alt_text || "Instagram media")}" loading="lazy" onerror="this.closest('.media-tile').classList.remove('has-media');this.remove()" />`;
}

function avatar(name, url) {
  const hue = hash(name || "g") % 360;
  return `<span class="avatar" style="--avatar:hsl(${hue} 58% 52%)">${url ? `<img src="${escapeAttr(url)}" alt="" />` : escapeHtml((name || "g").slice(0, 2).toUpperCase())}</span>`;
}

function gradientFor(value) {
  const h = hash(value) % 360;
  const h2 = (h + 64) % 360;
  return `--media-gradient:linear-gradient(145deg,hsl(${h} 74% 75%),hsl(${h2} 64% 55%) 52%,hsl(${(h + 160) % 360} 48% 29%))`;
}

async function api(path, options) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function relativeTime(value) {
  if (!value) return "unknown date";
  const delta = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(delta)) return String(value).slice(0, 10);
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatNumber(value) {
  return new Intl.NumberFormat(undefined, { notation: Number(value) >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(Number(value || 0));
}

function emptyState(title, detail) {
  return `<div class="empty-state"><div class="brand-mark">g</div><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p></div></div>`;
}

function highlight(text, query) {
  const safe = escapeHtml(text || "");
  const terms = query.split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (!terms.length) return safe;
  return safe.replace(new RegExp(`(${terms.join("|")})`, "gi"), "<mark>$1</mark>");
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  setTimeout(() => els.toast.classList.remove("show"), 3200);
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function hash(value) {
  return [...String(value)].reduce((result, char) => ((result << 5) - result + char.charCodeAt(0)) | 0, 0) >>> 0;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function escapeAttr(value) { return escapeHtml(value); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
