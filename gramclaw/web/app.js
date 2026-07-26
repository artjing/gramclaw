const state = {
  view: "home",
  status: null,
  query: "",
  theme: localStorage.getItem("gramclaw-theme") || "system",
  selected: new Set(),
  filters: {},
  collectionId: null,
  libraryMode: null,
  boardId: null,
  activeBoard: null,
  analysisTimer: null,
  autoOrganize: false,
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
  ask: ["Ask", "Visual search"],
  library: ["Saved Library", "Organized inspiration"],
  boards: ["Boards", "Arrange ideas"],
  analysis: ["Media analysis", "Private visual index"],
  inbox: ["Inbox", "Priority queue"],
  liked: ["Liked", "Things you noticed"],
  stories: ["Stories", "Ephemeral, preserved"],
  dms: ["Messages", "Local conversations"],
  network: ["Network", "Relationship memory"],
  insights: ["Insights", "Patterns, not vanity"],
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
    setView("ask");
  }, 260));
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
  els.dialog.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]");
    if (action) {
      event.preventDefault();
      await handleAction(action);
      return;
    }
    if (event.target === els.dialog) els.dialog.close();
  });
  els.content.addEventListener("click", handleContentClick);
  els.content.addEventListener("submit", handleContentSubmit);
  els.content.addEventListener("change", handleContentChange);
  els.content.addEventListener("focusout", handleContentFocusOut);
  els.content.addEventListener("pointerdown", beginBoardDrag);
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
    ["Media analyzed", `${formatNumber(counts.analyzed)} / ${formatNumber(counts.media)}`],
    ["Saved + liked", formatNumber(counts.saved + counts.liked)],
    ["Smart collections", formatNumber(counts.smartCollections)],
    ["Boards", formatNumber(counts.boards)],
  ].map(([label, value]) => `<div class="summary-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
}

async function setView(view) {
  state.view = view;
  if (view !== "boards") state.boardId = null;
  if (view !== "library") {
    state.collectionId = null;
    state.libraryMode = null;
  }
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  await render();
}

async function render() {
  clearTimeout(state.analysisTimer);
  const [title, eyebrow] = viewMeta[state.view] || viewMeta.home;
  els.title.textContent = title;
  els.eyebrow.textContent = eyebrow;
  els.content.innerHTML = `<div class="loading-state"><div class="loader"></div><p>Reading local SQLite…</p></div>`;
  try {
    if (["home", "liked", "stories"].includes(state.view)) await renderPosts();
    else if (state.view === "ask") await renderAsk();
    else if (state.view === "library") await renderLibrary();
    else if (state.view === "boards") await renderBoards();
    else if (state.view === "analysis") await renderAnalysis();
    else if (state.view === "inbox") await renderInbox();
    else if (state.view === "dms") await renderDms();
    else if (state.view === "network") await renderNetwork();
    else if (state.view === "insights") await renderInsights();
  } catch (error) {
    els.content.innerHTML = emptyState("Something went wrong", error.message);
  }
}

async function renderPosts() {
  const query = new URLSearchParams({ limit: "60" });
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
    <div class="feed-grid">${result.items.map((post) => postCard(post)).join("")}</div>`;
}

async function renderAsk() {
  const filterMarkup = searchFilters();
  if (!state.query) {
    els.content.innerHTML = `
      <section class="ask-hero">
        <span class="spark">✦</span>
        <h2>Search what you remember,<br>not where it was filed.</h2>
        <p>Gramclaw combines captions, OCR, image descriptions, objects, palettes, and visual concepts on your device.</p>
        <div class="query-examples">
          ${[
            "wooden interiors I saved last year",
            "blue ceramic posts from @linh.makes",
            "posters with readable typography",
            "quiet coastal images I liked",
          ].map((query) => `<button data-action="example-query" data-query="${escapeAttr(query)}">${escapeHtml(query)} <span>↗</span></button>`).join("")}
        </div>
      </section>
      ${filterMarkup}`;
    return;
  }
  const params = filtersToParams();
  params.set("q", state.query);
  params.set("limit", "90");
  const [visual, text, overview] = await Promise.all([
    api(`/api/visual-search?${params}`),
    api(`/api/search?q=${encodeURIComponent(state.query)}&scope=all`),
    api("/api/library"),
  ]);
  const interpretation = Object.entries(visual.interpretedAs)
    .filter(([key, value]) => key !== "semanticText" && value && (!Array.isArray(value) || value.length))
    .map(([key, value]) => `<span class="chip">${escapeHtml(key)} · ${escapeHtml(Array.isArray(value) ? value.join(", ") : String(value).slice(0, 24))}</span>`)
    .join("");
  els.content.innerHTML = `
    ${filterMarkup}
    <div class="section-head search-head">
      <div><h2>${visual.items.length} visual matches</h2><div class="chips interpretation">${interpretation || '<span class="chip">hybrid semantic search</span>'}</div></div>
      <p>Ranked locally · every result explains itself</p>
    </div>
    ${bulkToolbar(overview)}
    <div class="feed-grid search-results">${visual.items.map((post) => postCard(post, { selectable: true, reasons: post.why })).join("") || emptyState("No visual matches", "Broaden the phrase or remove one of the filters.")}</div>
    ${textSearchSection(text)}`;
}

function searchFilters() {
  return `
    <form class="filter-bar" id="filter-form">
      <label>Creator<input name="author" value="${escapeAttr(state.filters.author || "")}" placeholder="@username"></label>
      <label>From<input name="since" type="date" value="${escapeAttr(dateInput(state.filters.since))}"></label>
      <label>Until<input name="until" type="date" value="${escapeAttr(dateInput(state.filters.until))}"></label>
      <label>Type<select name="kind"><option value="">Any media</option>${["post", "carousel", "reel", "story"].map((kind) => `<option ${state.filters.kind === kind ? "selected" : ""}>${kind}</option>`).join("")}</select></label>
      <label>Color<select name="color"><option value="">Any color</option>${["black", "blue", "brown", "cream", "green", "orange", "pink", "purple", "red", "white", "yellow"].map((color) => `<option ${state.filters.color === color ? "selected" : ""}>${color}</option>`).join("")}</select></label>
      <label>Topic<input name="topic" value="${escapeAttr(state.filters.topic || "")}" placeholder="interiors"></label>
      <label class="check-filter"><input name="saved" type="checkbox" ${state.filters.saved ? "checked" : ""}>Saved</label>
      <label class="check-filter"><input name="liked" type="checkbox" ${state.filters.liked ? "checked" : ""}>Liked</label>
      <button class="small-button" type="submit">Apply</button>
      <button class="text-button" type="button" data-action="clear-filters">Clear</button>
    </form>`;
}

function textSearchSection(result) {
  const items = [
    ...result.comments.map((item) => ({ type: "post", id: item.post_id, title: `Comment by @${item.author_username || "unknown"}`, text: item.text, date: item.created_at })),
    ...result.messages.map((item) => ({ type: "thread", id: item.thread_id, title: item.thread_title, text: item.text, date: item.created_at })),
  ].sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))).slice(0, 12);
  if (!items.length) return "";
  return `
    <details class="secondary-results">
      <summary>${items.length} matching comments and messages</summary>
      <div class="list-panel">${items.map((item) => `
        <button class="list-row" data-${item.type}-id="${escapeAttr(item.id)}">
          <div class="score">${item.type === "post" ? "C" : "DM"}</div>
          <div><h3>${escapeHtml(item.title)}</h3><p>${highlight(item.text, state.query)}</p></div>
          <time>${relativeTime(item.date)}</time>
        </button>`).join("")}</div>
    </details>`;
}

async function renderLibrary() {
  const duplicatePromise = state.libraryMode === "duplicates" ? api("/api/library/duplicates") : Promise.resolve(null);
  const [overview, savedResult, duplicates] = await Promise.all([
    api("/api/library"),
    api(`/api/visual-search?saved=1&limit=500${state.collectionId ? `&collectionId=${encodeURIComponent(state.collectionId)}` : ""}${state.libraryMode === "unorganized" ? "&unorganized=1" : ""}`),
    duplicatePromise,
  ]);
  const active = overview.collections.find((item) => item.id === state.collectionId);
  const modeTitle = state.libraryMode === "unorganized" ? "Unorganized" : state.libraryMode === "duplicates" ? "Duplicate review" : null;
  els.content.innerHTML = `
    <section class="library-hero">
      <div>
        <p class="eyebrow">Smart Saved</p>
        <h2>${escapeHtml(modeTitle || active?.name || `${formatNumber(overview.savedCount)} references, ready to think with.`)}</h2>
        <p>${state.libraryMode === "unorganized" ? "Saved references that have not joined a collection or tag yet." : state.libraryMode === "duplicates" ? "Exact media fingerprints grouped for a quick visual review." : active ? escapeHtml(active.description) : "Automatic visual topics sit alongside your own collections and tags. Nothing leaves this machine."}</p>
      </div>
      <div class="library-actions">
        ${active || state.libraryMode ? '<button class="secondary-button" data-action="all-library">← All collections</button>' : ""}
        <button class="secondary-button" data-action="create-collection">＋ Collection</button>
        <button class="sync-button" data-action="organize">✦ Organize</button>
      </div>
    </section>
    ${active || state.libraryMode ? "" : `
      <div class="library-stats">
        <div><strong>${formatNumber(overview.collections.length)}</strong><span>Collections</span></div>
        <div><strong>${formatNumber(overview.tags.length)}</strong><span>Tags</span></div>
        <button data-action="review-unorganized"><strong>${formatNumber(overview.unorganizedCount)}</strong><span>Unorganized →</span></button>
        <button data-action="review-duplicates"><strong>${formatNumber(overview.duplicates)}</strong><span>Duplicate groups →</span></button>
      </div>
      <div class="collection-grid">
        ${overview.collections.filter((item) => item.count > 0 || item.kind === "custom").map(collectionCard).join("") || emptyState("No collections yet", "Analyze your media, then organize the Saved library.")}
      </div>
      ${overview.tags.length ? `<div class="section-head"><h2>Tags</h2></div><div class="chips tag-cloud">${overview.tags.map((tag) => `<span class="tag-chip" style="--tag:${escapeAttr(tag.color)}">${escapeHtml(tag.name)} · ${tag.count}</span>`).join("")}</div>` : ""}
    `}
    ${state.libraryMode === "duplicates" ? duplicateReview(duplicates?.items || []) : `
    <div class="section-head"><h2>${escapeHtml(modeTitle || active?.name || "All Saved")}</h2><p>Select several items for bulk organization</p></div>
    ${bulkToolbar(overview)}
    <div class="feed-grid">${savedResult.items.map((post) => postCard(post, { selectable: true })).join("") || emptyState(state.libraryMode === "unorganized" ? "Everything is organized" : "Nothing in this collection", state.libraryMode === "unorganized" ? "Every Saved item belongs to a collection or tag." : "Select Saved posts and add them here.")}</div>`}`;
}

function duplicateReview(groups) {
  return `
    <div class="duplicate-groups">
      ${groups.map((group, index) => `
        <section class="duplicate-group">
          <div class="section-head"><h2>Group ${index + 1}</h2><p>${group.items.length} matching fingerprints</p></div>
          <div class="feed-grid">${group.items.map((post) => postCard(post, { selectable: true, reasons: ["Duplicate fingerprint"] })).join("")}</div>
        </section>`).join("") || emptyState("No duplicates found", "Gramclaw did not find repeated media fingerprints in your analyzed Saved library.")}
    </div>`;
}

function collectionCard(item) {
  return `
    <button class="collection-card" data-action="open-collection" data-id="${escapeAttr(item.id)}" style="--collection:${escapeAttr(item.color)}">
      <div class="collection-cover">${item.cover_media_id ? `<img src="/media/${encodeURIComponent(item.cover_media_id)}" alt="" onerror="this.remove()">` : "<span>✦</span>"}</div>
      <div><span>${item.kind}</span><strong>${escapeHtml(item.name)}</strong><small>${item.count} items</small></div>
    </button>`;
}

async function renderAnalysis() {
  const status = await api("/api/analysis/status");
  const completed = status.counts.completed;
  const remaining = status.counts.queued + status.counts.running;
  els.content.innerHTML = `
    <section class="analysis-panel">
      <div class="analysis-orb"><span>${status.active ? "↻" : "✦"}</span></div>
      <div class="analysis-copy">
        <p class="eyebrow">Local by default</p>
        <h2>${status.active ? "Building your visual memory…" : `${formatNumber(completed)} media items understood`}</h2>
        <p>${escapeHtml(status.localEngine)} extracts text, visual labels, palettes, style, and private embeddings. Cloud vision is opt-in per run.</p>
        <div class="progress-track"><i style="width:${status.progress}%"></i></div>
        <div class="progress-meta"><span>${status.progress}% complete</span><span>${remaining} remaining · ${status.counts.failed} failed</span></div>
        <div class="analysis-actions">
          <button class="sync-button" data-action="analyze-local" ${status.active ? "disabled" : ""}>✦ Analyze locally</button>
          <button class="secondary-button" data-action="analyze-cloud" ${status.active ? "disabled" : ""}>Cloud vision${status.cloudAvailable ? "" : " · key required"}</button>
          ${status.counts.failed ? '<button class="secondary-button" data-action="retry-analysis">Retry failed</button>' : ""}
        </div>
      </div>
      <aside class="analysis-features">
        ${[
          ["OCR", "Readable words and type"],
          ["Vision", "Objects and scenes"],
          ["Palette", "Dominant colors"],
          ["Style", "Mood, light, composition"],
          ["Embedding", "Conceptual similarity"],
          ["Fingerprint", "Duplicate detection"],
        ].map(([title, detail]) => `<div><span>✓</span><p><strong>${title}</strong>${detail}</p></div>`).join("")}
      </aside>
    </section>
    <div class="privacy-note"><strong>Privacy boundary</strong><p>Local analysis never makes a network request. Cloud vision sends only the selected media to your configured API account and runs only after you choose it.</p></div>`;
  if (status.active) {
    state.analysisTimer = setTimeout(async () => {
      const next = await api("/api/analysis/status");
      if (!next.active && state.autoOrganize) {
        state.autoOrganize = false;
        await api("/api/library/organize", { method: "POST", body: "{}" });
        await refreshStatus();
        toast("Analysis complete · Saved library organized");
      }
      if (state.view === "analysis") renderAnalysis();
    }, 900);
  }
}

async function renderBoards() {
  if (state.boardId) {
    const board = await api(`/api/boards/${encodeURIComponent(state.boardId)}`);
    state.activeBoard = board;
    els.title.textContent = board.name;
    els.content.innerHTML = `
      <div class="board-toolbar">
        <button class="secondary-button" data-action="boards-list">← Boards</button>
        <label>Background <input type="color" data-board-background value="${escapeAttr(board.background)}"></label>
        <span>${board.items.length} references</span>
        <button class="secondary-button" data-action="export-png">Download image</button>
        <button class="sync-button" data-action="export-pdf">Export PDF</button>
      </div>
      <div class="board-scroll">
        <div class="board-canvas" style="--board-bg:${escapeAttr(board.background)}">
          ${board.items.map(boardItem).join("")}
          ${board.items.length ? "" : '<div class="board-empty">Select posts in Ask or Library, then add them to this board.</div>'}
        </div>
      </div>`;
    return;
  }
  const result = await api("/api/boards");
  els.content.innerHTML = `
    <section class="library-hero">
      <div><p class="eyebrow">Moodboards</p><h2>Turn search results into a point of view.</h2><p>Arrange references freely, add working notes, and export a presentation-ready image or PDF.</p></div>
      <button class="sync-button" data-action="create-board">＋ New board</button>
    </section>
    <div class="boards-grid">
      ${result.items.map((board) => `
        <button class="board-card" data-action="open-board" data-id="${escapeAttr(board.id)}" style="--board-bg:${escapeAttr(board.background)}">
          <div class="board-mini">${board.cover_media_id ? `<img src="/media/${encodeURIComponent(board.cover_media_id)}" alt="" onerror="this.remove()">` : "<span>▱</span>"}</div>
          <div><strong>${escapeHtml(board.name)}</strong><p>${escapeHtml(board.description || "Untitled direction")}</p><small>${board.item_count} references · ${relativeTime(board.updated_at)}</small></div>
        </button>`).join("") || emptyState("No boards yet", "Create one, then add visual results from Ask or Library.")}
    </div>`;
}

function boardItem(item) {
  const src = mediaSrc(item);
  return `
    <article class="board-item" data-board-item="${escapeAttr(item.id)}" style="left:${item.x}px;top:${item.y}px;width:${item.width}px;height:${item.height}px;--rotation:${item.rotation}deg">
      <div class="board-image" style="${gradientFor(item.id)}">${src ? `<img src="${escapeAttr(src)}" alt="${escapeAttr(item.alt_text || item.caption || "Board reference")}" draggable="false" onerror="this.remove()">` : ""}</div>
      <div class="board-label"><strong>@${escapeHtml(item.author_username)}</strong><button data-action="remove-board-item" data-id="${escapeAttr(item.id)}" aria-label="Remove">×</button></div>
      <textarea data-board-note="${escapeAttr(item.id)}" placeholder="Add a note…">${escapeHtml(item.note)}</textarea>
    </article>`;
}

function postCard(post, options = {}) {
  const media = post.media?.[0];
  const reasons = options.reasons?.length ? `<div class="match-reasons">${options.reasons.map((reason) => `<span>✓ ${escapeHtml(reason)}</span>`).join("")}</div>` : "";
  const analysis = post.analysis || media?.analysis;
  const palette = analysis?.colors?.length ? `<div class="mini-palette">${analysis.colors.slice(0, 4).map((color) => `<i style="--swatch:${escapeAttr(color)}"></i>`).join("")}</div>` : "";
  const selected = state.selected.has(post.id);
  return `
    <article class="post-card ${selected ? "selected" : ""}" data-post-id="${escapeAttr(post.id)}" tabindex="0">
      <div class="media-tile ${mediaMarkupFor(media) ? "has-media" : ""}" style="${gradientFor(post.id)}">
        ${mediaMarkupFor(media)}
        <span class="media-kind">${escapeHtml(post.kind)}</span>
        ${options.selectable ? `<button class="select-post ${selected ? "active" : ""}" data-action="select-post" data-id="${escapeAttr(post.id)}" aria-label="Select post">${selected ? "✓" : "＋"}</button>` : ""}
        ${palette}
      </div>
      <div class="post-body">
        <div class="post-author">
          ${avatar(post.author_username, post.author_avatar_url)}
          <div><strong>@${escapeHtml(post.author_username)}</strong><span>${relativeTime(post.created_at)}</span></div>
        </div>
        <p class="post-caption">${escapeHtml(post.caption || analysis?.description || "Media saved without a caption.")}</p>
        ${reasons}
        <div class="post-meta"><div><span>♡ ${formatNumber(post.like_count)}</span><span>◌ ${formatNumber(post.comment_count)}</span></div><span class="${post.saved ? "saved" : ""}">${post.saved ? "◆" : "◇"}</span></div>
      </div>
    </article>`;
}

function bulkToolbar(overview) {
  const collections = overview?.collections || [];
  return `
    <div class="bulk-toolbar ${state.selected.size ? "active" : ""}">
      <strong>${state.selected.size} selected</strong>
      <select id="bulk-target">
        <option value="">Choose destination…</option>
        ${collections.map((item) => `<option value="collection:${escapeAttr(item.id)}">${escapeHtml(item.name)}</option>`).join("")}
        <option value="boards">Choose a board…</option>
      </select>
      <button data-action="bulk-add">Add</button>
      <button data-action="bulk-tag">Tag</button>
      <button class="text-button" data-action="clear-selection">Clear</button>
    </div>`;
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
      <article class="metric-card wide"><div class="section-head"><h2>Strongest mutuals</h2><p>Sorted by local follower context</p></div><div class="list-panel">${mutualsResult.data.map((person) => personRow(person)).join("") || emptyState("No mutuals yet", "Import followers and following to build the graph.")}</div></article>
      <article class="metric-card wide"><div class="section-head"><h2>Relationship events</h2><p>Append-only history</p></div><div class="list-panel">${recentResult.data.map((event) => `<div class="list-row">${avatar(event.username, event.avatar_url)}<div><h3>@${escapeHtml(event.username)}</h3><p>${event.event_type === "started" ? "Relationship appeared" : "Relationship ended"} · ${escapeHtml(event.direction)}</p></div><time>${relativeTime(event.event_at)}</time></div>`).join("") || emptyState("No changes recorded", "A second complete relationship sync will reveal churn.")}</div></article>
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

async function handleContentClick(event) {
  const action = event.target.closest("[data-action]");
  if (action) {
    event.preventDefault();
    event.stopPropagation();
    await handleAction(action);
    return;
  }
  const post = event.target.closest("[data-post-id]");
  const thread = event.target.closest("[data-thread-id]");
  const profile = event.target.closest("[data-profile-id]");
  if (post) await openPost(post.dataset.postId);
  else if (thread) await openThread(thread.dataset.threadId);
  else if (profile) await openProfile(profile.dataset.profileId);
}

async function handleAction(element) {
  const action = element.dataset.action;
  if (action === "example-query") {
    state.query = element.dataset.query;
    els.search.value = state.query;
    await renderAsk();
  } else if (action === "clear-filters") {
    state.filters = {};
    await renderAsk();
  } else if (action === "select-post") {
    const id = element.dataset.id;
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    await render();
  } else if (action === "clear-selection") {
    state.selected.clear();
    await render();
  } else if (action === "bulk-add") {
    await bulkAdd();
  } else if (action === "bulk-tag") {
    await bulkTag();
  } else if (action === "organize") {
    const result = await api("/api/library/organize", { method: "POST", body: "{}" });
    toast(`Organized ${result.organized} saved items`);
    await refreshStatus();
    await renderLibrary();
  } else if (action === "create-collection") {
    const name = prompt("Collection name");
    if (!name) return;
    const collection = await api("/api/library/collections", { method: "POST", body: JSON.stringify({ name, postIds: [...state.selected] }) });
    toast(`Created ${collection.name}`);
    state.selected.clear();
    await refreshStatus();
    await renderLibrary();
  } else if (action === "open-collection") {
    state.collectionId = element.dataset.id;
    await renderLibrary();
  } else if (action === "all-library") {
    state.collectionId = null;
    state.libraryMode = null;
    await renderLibrary();
  } else if (action === "review-unorganized") {
    state.libraryMode = "unorganized";
    state.collectionId = null;
    await renderLibrary();
  } else if (action === "review-duplicates") {
    state.libraryMode = "duplicates";
    state.collectionId = null;
    await renderLibrary();
  } else if (action === "analyze-local" || action === "analyze-cloud") {
    const provider = action.endsWith("cloud") ? "cloud" : "local";
    state.autoOrganize = true;
    await api("/api/analysis/run", { method: "POST", body: JSON.stringify({ provider, limit: 5000 }) });
    toast(provider === "local" ? "Private local analysis started" : "Optional cloud analysis started");
    await renderAnalysis();
  } else if (action === "retry-analysis") {
    await api("/api/analysis/retry", { method: "POST", body: JSON.stringify({ provider: "local" }) });
    await renderAnalysis();
  } else if (action === "create-board") {
    const name = prompt("Board name");
    if (!name) return;
    const board = await api("/api/boards", { method: "POST", body: JSON.stringify({ name, postIds: [...state.selected] }) });
    state.selected.clear();
    state.boardId = board.id;
    await refreshStatus();
    await renderBoards();
  } else if (action === "open-board") {
    state.boardId = element.dataset.id;
    await renderBoards();
  } else if (action === "boards-list") {
    state.boardId = null;
    state.activeBoard = null;
    els.title.textContent = viewMeta.boards[0];
    await renderBoards();
  } else if (action === "remove-board-item") {
    await api(`/api/boards/${encodeURIComponent(state.boardId)}/items/${encodeURIComponent(element.dataset.id)}`, { method: "DELETE", body: "{}" });
    await renderBoards();
  } else if (action === "export-png") {
    await exportBoardPng(state.activeBoard);
  } else if (action === "export-pdf") {
    exportBoardPdf(state.activeBoard);
  }
}

async function handleContentSubmit(event) {
  if (event.target.id !== "filter-form") return;
  event.preventDefault();
  const form = new FormData(event.target);
  state.filters = {
    author: form.get("author"),
    since: form.get("since"),
    until: form.get("until"),
    kind: form.get("kind"),
    color: form.get("color"),
    topic: form.get("topic"),
    saved: form.get("saved") === "on",
    liked: form.get("liked") === "on",
  };
  await renderAsk();
}

async function handleContentChange(event) {
  if (event.target.matches("[data-board-background]") && state.activeBoard) {
    state.activeBoard.background = event.target.value;
    await api(`/api/boards/${encodeURIComponent(state.activeBoard.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ background: event.target.value }),
    });
    document.querySelector(".board-canvas")?.style.setProperty("--board-bg", event.target.value);
  }
}

async function handleContentFocusOut(event) {
  if (!event.target.matches("[data-board-note]") || !state.activeBoard) return;
  await api(`/api/boards/${encodeURIComponent(state.activeBoard.id)}/items/${encodeURIComponent(event.target.dataset.boardNote)}`, {
    method: "PATCH",
    body: JSON.stringify({ note: event.target.value }),
  });
  const item = state.activeBoard.items.find((candidate) => candidate.id === event.target.dataset.boardNote);
  if (item) item.note = event.target.value;
}

async function bulkAdd() {
  if (!state.selected.size) return toast("Select at least one post");
  const target = document.querySelector("#bulk-target")?.value;
  if (target?.startsWith("collection:")) {
    await api(`/api/library/collections/${encodeURIComponent(target.slice(11))}/items`, {
      method: "POST",
      body: JSON.stringify({ postIds: [...state.selected] }),
    });
    toast(`Added ${state.selected.size} items to collection`);
  } else {
    const boards = await api("/api/boards");
    if (!boards.items.length) {
      const name = prompt("Create a board");
      if (!name) return;
      await api("/api/boards", { method: "POST", body: JSON.stringify({ name, postIds: [...state.selected] }) });
    } else {
      const labels = boards.items.map((board, index) => `${index + 1}. ${board.name}`).join("\n");
      const chosen = Number(prompt(`Add to which board?\n${labels}`)) - 1;
      if (!boards.items[chosen]) return;
      await api(`/api/boards/${encodeURIComponent(boards.items[chosen].id)}/items`, {
        method: "POST",
        body: JSON.stringify({ postIds: [...state.selected] }),
      });
    }
    toast(`Added ${state.selected.size} items to board`);
  }
  state.selected.clear();
  await refreshStatus();
  await render();
}

async function bulkTag() {
  if (!state.selected.size) return toast("Select at least one post");
  const name = prompt("Tag name");
  if (!name) return;
  const tag = await api("/api/library/tags", {
    method: "POST",
    body: JSON.stringify({ name, postIds: [...state.selected] }),
  });
  toast(`Tagged ${state.selected.size} items “${tag.name}”`);
  state.selected.clear();
  await render();
}

function beginBoardDrag(event) {
  const card = event.target.closest("[data-board-item]");
  if (!card || event.target.closest("button, textarea") || !state.activeBoard) return;
  event.preventDefault();
  card.setPointerCapture(event.pointerId);
  const canvas = card.closest(".board-canvas");
  const startX = event.clientX;
  const startY = event.clientY;
  const startLeft = Number.parseFloat(card.style.left);
  const startTop = Number.parseFloat(card.style.top);
  const ratio = 1000 / canvas.getBoundingClientRect().width;
  const move = (next) => {
    const left = Math.max(0, Math.min(1000 - card.offsetWidth, startLeft + (next.clientX - startX) * ratio));
    const top = Math.max(0, Math.min(720 - card.offsetHeight, startTop + (next.clientY - startY) * ratio));
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  };
  const end = async (next) => {
    move(next);
    card.removeEventListener("pointermove", move);
    card.removeEventListener("pointerup", end);
    const item = state.activeBoard.items.find((candidate) => candidate.id === card.dataset.boardItem);
    if (item) {
      item.x = Number.parseFloat(card.style.left);
      item.y = Number.parseFloat(card.style.top);
      await api(`/api/boards/${encodeURIComponent(state.activeBoard.id)}/items/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ x: item.x, y: item.y }),
      });
    }
  };
  card.addEventListener("pointermove", move);
  card.addEventListener("pointerup", end, { once: true });
}

async function openPost(id) {
  const post = await api(`/api/posts/${encodeURIComponent(id)}`);
  const media = post.media?.[0];
  const analysis = media?.analysis;
  els.dialogContent.innerHTML = `
    <div class="post-detail">
      <div class="media-tile ${mediaMarkupFor(media) ? "has-media" : ""}" style="${gradientFor(post.id)}">${mediaMarkupFor(media)}</div>
      <div class="post-detail-copy">
        <div class="post-author">${avatar(post.author_username, post.author_avatar_url)}<div><strong>@${escapeHtml(post.author_username)}</strong><span>${relativeTime(post.created_at)}</span></div></div>
        <h2>${escapeHtml(post.kind)}</h2>
        <p>${escapeHtml(post.caption || "No caption")}</p>
        ${analysis ? `
          <div class="analysis-detail">
            <p class="eyebrow">Visual analysis · ${escapeHtml(analysis.provider)}</p>
            <strong>${escapeHtml(analysis.description)}</strong>
            ${analysis.ocrText ? `<p><b>OCR</b> ${escapeHtml(analysis.ocrText)}</p>` : ""}
            <div class="chips">${analysis.objects.map((object) => `<span class="chip">${escapeHtml(object)}</span>`).join("")}</div>
            <div class="palette-row">${analysis.colors.map((color) => `<i style="--swatch:${escapeAttr(color)}" title="${escapeAttr(color)}"></i>`).join("")}</div>
          </div>` : '<button class="secondary-button" data-action="analyze-local">Analyze this library</button>'}
        <div class="chips">${post.libraryCollections.map((item) => `<span class="chip">${escapeHtml(item.name)}</span>`).join("")}${post.tags.map((tag) => `<span class="tag-chip" style="--tag:${escapeAttr(tag.color)}">${escapeHtml(tag.name)}</span>`).join("")}</div>
        <div class="post-meta"><div><span>♡ ${formatNumber(post.like_count)}</span><span>◌ ${formatNumber(post.comment_count)}</span></div><span>${post.saved ? "◆ saved" : "◇"}</span></div>
        <div class="comments">${post.comments.length ? post.comments.map((comment) => `<div class="comment"><strong>@${escapeHtml(comment.author_username || "unknown")}</strong><p>${escapeHtml(comment.text)}</p></div>`).join("") : "<div class='comment'><p>No comments cached.</p></div>"}</div>
      </div>
    </div>`;
  els.dialog.showModal();
}

async function openThread(id) {
  const thread = await api(`/api/threads/${encodeURIComponent(id)}`);
  els.dialogContent.innerHTML = `<div class="post-detail-copy"><p class="eyebrow">Direct messages</p><h2>${escapeHtml(thread.title)}</h2><div class="comments">${thread.messages.map((message) => `<div class="comment"><strong>${escapeHtml(message.sender_display_name || message.sender_username || message.direction)}</strong><p>${escapeHtml(message.text)}</p><time>${relativeTime(message.created_at)}</time></div>`).join("")}</div></div>`;
  els.dialog.showModal();
}

async function openProfile(id) {
  const profile = await api(`/api/profiles/${encodeURIComponent(id)}`);
  els.dialogContent.innerHTML = `<div class="post-detail-copy"><div class="post-author">${avatar(profile.username, profile.avatar_url)}<div><strong>${escapeHtml(profile.display_name)}</strong><span>@${escapeHtml(profile.username)}</span></div></div><h2>${formatNumber(profile.followers_count)} followers</h2><p>${escapeHtml(profile.biography || "No bio cached.")}</p><div class="chips"><span class="chip">${profile.relationship.followsYou ? "Follows you" : "Doesn’t follow you"}</span><span class="chip">${profile.relationship.youFollow ? "You follow" : "Not following"}</span></div></div>`;
  els.dialog.showModal();
}

async function syncCurrentView() {
  const stream = {
    home: "timeline", library: "saved", liked: "liked", dms: "dms",
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

async function exportBoardPng(board) {
  if (!board) return;
  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = 1152;
  const context = canvas.getContext("2d");
  context.fillStyle = board.background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = document.documentElement.dataset.theme === "dark" ? "#f4f1e8" : "#171814";
  context.font = "700 38px system-ui";
  context.fillText(board.name, 48, 58);
  context.font = "18px system-ui";
  context.fillText(board.description || "Gramclaw board", 48, 90);
  const scale = 1.5;
  for (const item of board.items) {
    context.save();
    const x = item.x * scale + 50;
    const y = item.y * scale + 105;
    const width = item.width * scale;
    const height = item.height * scale;
    context.translate(x + width / 2, y + height / 2);
    context.rotate(item.rotation * Math.PI / 180);
    context.fillStyle = "#fff";
    context.shadowColor = "rgba(0,0,0,.16)";
    context.shadowBlur = 24;
    context.fillRect(-width / 2, -height / 2, width, height);
    context.shadowBlur = 0;
    const image = await loadImage(mediaSrc(item));
    if (image) drawCover(context, image, -width / 2 + 12, -height / 2 + 12, width - 24, height - 94);
    else {
      context.fillStyle = `hsl(${hash(item.id) % 360} 45% 72%)`;
      context.fillRect(-width / 2 + 12, -height / 2 + 12, width - 24, height - 94);
    }
    context.fillStyle = "#191a16";
    context.font = "600 17px system-ui";
    context.fillText(`@${item.author_username}`, -width / 2 + 18, height / 2 - 48);
    context.font = "14px system-ui";
    context.fillText((item.note || item.caption || "").slice(0, 48), -width / 2 + 18, height / 2 - 22);
    context.restore();
  }
  const link = document.createElement("a");
  link.download = `${safeFilename(board.name)}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
  toast("Board image downloaded");
}

function exportBoardPdf(board) {
  if (!board) return;
  const popup = window.open("", "_blank", "width=1200,height=900");
  if (!popup) return toast("Allow pop-ups to export PDF");
  popup.document.write(`<!doctype html><html><head><title>${escapeHtml(board.name)}</title><style>
    @page{size:landscape;margin:0}*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:${escapeAttr(board.background)}}
    main{position:relative;width:1000px;height:720px;margin:0 auto;background:${escapeAttr(board.background)};overflow:hidden}
    h1{position:absolute;left:24px;top:12px;margin:0;font-size:24px}.item{position:absolute;padding:8px 8px 46px;background:#fff;box-shadow:0 8px 24px #0002;transform:rotate(var(--r))}
    .item img,.placeholder{width:100%;height:100%;object-fit:cover;background:#ccc}.item strong{position:absolute;left:10px;bottom:26px;font-size:10px}.item p{position:absolute;left:10px;bottom:8px;margin:0;font-size:9px}
  </style></head><body><main><h1>${escapeHtml(board.name)}</h1>${board.items.map((item) => {
    const src = mediaSrc(item);
    return `<article class="item" style="left:${item.x}px;top:${item.y}px;width:${item.width}px;height:${item.height}px;--r:${item.rotation}deg">${src ? `<img src="${escapeAttr(src)}">` : '<div class="placeholder"></div>'}<strong>@${escapeHtml(item.author_username)}</strong><p>${escapeHtml(item.note || "")}</p></article>`;
  }).join("")}</main><script>setTimeout(()=>print(),700)<\/script></body></html>`);
  popup.document.close();
}

function drawCover(context, image, x, y, width, height) {
  const ratio = Math.max(width / image.width, height / image.height);
  const drawWidth = image.width * ratio;
  const drawHeight = image.height * ratio;
  context.save();
  context.beginPath();
  context.rect(x, y, width, height);
  context.clip();
  context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
  context.restore();
}

function loadImage(src) {
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

function filtersToParams() {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state.filters)) {
    if (value) params.set(key, value === true ? "1" : value);
  }
  return params;
}

function mediaSrc(media) {
  if (!media) return "";
  return media.local_path ? `/media/${encodeURIComponent(media.media_id || media.id)}` : media.remote_url;
}

function mediaMarkupFor(media) {
  if (!media) return "";
  const src = mediaSrc(media);
  if (!src) return "";
  if (media.media_type === "video") return `<video src="${escapeAttr(src)}" muted playsinline preload="metadata"></video>`;
  return `<img src="${escapeAttr(src)}" alt="${escapeAttr(media.alt_text || "Instagram media")}" loading="lazy" onerror="this.closest('.media-tile').classList.remove('has-media');this.remove()">`;
}

function avatar(name, url) {
  const hue = hash(name || "g") % 360;
  return `<span class="avatar" style="--avatar:hsl(${hue} 58% 52%)">${url ? `<img src="${escapeAttr(url)}" alt="">` : escapeHtml((name || "g").slice(0, 2).toUpperCase())}</span>`;
}

function gradientFor(value) {
  const hue = hash(value) % 360;
  return `--media-gradient:linear-gradient(145deg,hsl(${hue} 74% 75%),hsl(${(hue + 64) % 360} 64% 55%) 52%,hsl(${(hue + 160) % 360} 48% 29%))`;
}

async function api(path, options) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
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

function dateInput(value) {
  return value ? String(value).slice(0, 10) : "";
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
  return terms.length ? safe.replace(new RegExp(`(${terms.join("|")})`, "gi"), "<mark>$1</mark>") : safe;
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

function safeFilename(value) {
  return String(value || "gramclaw-board").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function escapeAttr(value) { return escapeHtml(value); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
