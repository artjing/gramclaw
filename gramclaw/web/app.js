const state = {
  view: "home",
  status: null,
  query: "",
  theme: localStorage.getItem("gramclaw-theme") || "system",
  selected: new Set(),
  filters: {},
  collectionId: null,
  igCollectionId: null,
  libraryMode: null,
  boardId: null,
  activeBoard: null,
  analysisTimer: null,
  autoOrganize: false,
  authStatus: null,
  authUi: {
    state: "idle",
    attemptId: null,
    prompt: null,
    username: "",
    result: null,
    errorCode: null,
    errorMessage: null,
    archives: null,
    archivePath: "",
    importResult: null,
  },
  authController: null,
  onboardingDismissed: false,
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
  onboarding: document.querySelector("#auth-onboarding"),
  accountPill: document.querySelector("#account-pill"),
  connectionDialog: document.querySelector("#connection-dialog"),
  connectionContent: document.querySelector("#connection-content"),
  toast: document.querySelector("#toast"),
};

const viewMeta = {
  home: ["Home", "Personal archive"],
  ask: ["Ask", "Visual search"],
  library: ["Saved", "Everything you've saved, organized inspiration on top"],
  boards: ["Boards", "Arrange ideas"],
  analysis: ["Media analysis", "Private visual index"],
  inbox: ["Inbox", "Priority queue"],
  liked: ["Liked", "Things you noticed"],
  stories: ["Stories", "Ephemeral, preserved"],
  dms: ["Messages", "Local conversations"],
  network: ["Network", "Relationship memory"],
  insights: ["Insights", "Patterns, not vanity"],
};

// One real URL per view (path-based, matching Birdclaw's per-page routing).
// "home" is "/" ; every other view is "/<view>". Library and boards also
// carry their sub-state (collection/board selection, library mode) as query
// params so those states are deep-linkable and reload-safe too.
const PATH_BY_VIEW = {
  home: "/", ask: "/ask", library: "/library", boards: "/boards",
  analysis: "/analysis", inbox: "/inbox", liked: "/liked", stories: "/stories",
  dms: "/dms", network: "/network", insights: "/insights",
};
const VIEW_BY_PATH = Object.fromEntries(
  Object.entries(PATH_BY_VIEW).map(([view, path]) => [path, view]),
);

function urlForState() {
  const path = PATH_BY_VIEW[state.view] ?? "/";
  const query = new URLSearchParams();
  if (state.view === "library") {
    if (state.collectionId) query.set("collection", state.collectionId);
    if (state.igCollectionId) query.set("igCollection", state.igCollectionId);
    if (state.libraryMode) query.set("mode", state.libraryMode);
  } else if (state.view === "boards" && state.boardId) {
    query.set("board", state.boardId);
  }
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}

function applyLocationToState(url) {
  state.view = VIEW_BY_PATH[url.pathname] ?? "home";
  state.collectionId = state.view === "library" ? url.searchParams.get("collection") : null;
  state.igCollectionId = state.view === "library" ? url.searchParams.get("igCollection") : null;
  state.libraryMode = state.view === "library" ? url.searchParams.get("mode") : null;
  state.boardId = state.view === "boards" ? url.searchParams.get("board") : null;
}

// Push/replace the address bar to match current state, then re-render.
// Call after any state change that should be its own back/forward stop
// (view switches, opening a collection/board, library mode changes).
function syncUrl({ push = true } = {}) {
  const target = urlForState();
  const current = `${location.pathname}${location.search}`;
  if (target === current) return;
  if (push) history.pushState({ view: state.view }, "", target);
  else history.replaceState({ view: state.view }, "", target);
}

init();

async function init() {
  applyTheme();
  applyLocationToState(new URL(location.href));
  syncUrl({ push: false });
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === state.view));
  bindEvents();
  window.addEventListener("popstate", async () => {
    applyLocationToState(new URL(location.href));
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === state.view));
    await render();
  });
  await Promise.all([refreshStatus(), refreshAuthStatus()]);
  renderAccountPill();
  if (shouldGateOnboarding()) showOnboarding();
  else await render();
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
  els.accountPill.addEventListener("click", openConnectionDialog);
  els.connectionDialog.querySelector(".dialog-close").addEventListener("click", () => els.connectionDialog.close());
  els.connectionDialog.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-connection-action]");
    if (action) {
      event.preventDefault();
      await handleConnectionAction(action.dataset.connectionAction);
    } else if (event.target === els.connectionDialog) {
      els.connectionDialog.close();
    }
  });
  els.onboarding.addEventListener("submit", handleAuthSubmit);
  els.onboarding.addEventListener("click", handleAuthClick);
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

async function refreshAuthStatus() {
  state.authStatus = await api("/api/auth/status");
  renderAccountPill();
}

function hasUsableLiveSession() {
  return Boolean(
    state.authStatus?.direct?.available
    || state.authStatus?.cookie?.available
    || state.authStatus?.graph?.available,
  );
}

function isEmptyWorkspace() {
  const counts = state.status?.counts ?? {};
  // A default account/profile from `gramclaw init` should not hide onboarding.
  return Number(counts.posts ?? 0) === 0
    && Number(counts.comments ?? 0) === 0
    && Number(counts.dmMessages ?? 0) === 0
    && Number(counts.saved ?? 0) === 0
    && Number(counts.liked ?? 0) === 0;
}

function shouldGateOnboarding() {
  // Empty libraries always start with archive import, even if a browser
  // Instagram session exists on this machine.
  return !state.onboardingDismissed && isEmptyWorkspace();
}

function showOnboarding(options = {}) {
  if (options.reset !== false) {
    state.authUi = {
      state: options.mode === "login" ? "login" : options.mode === "import" ? "import" : "idle",
      attemptId: null,
      prompt: null,
      username: state.authStatus?.direct?.username ?? state.status?.account?.username ?? "",
      result: null,
      errorCode: null,
      errorMessage: null,
      archives: null,
      archivePath: "",
      importResult: null,
    };
  }
  document.body.classList.add("onboarding-active");
  els.onboarding.hidden = false;
  renderAuthPanel();
  if (state.authUi.state === "import") {
    void loadArchiveCandidates();
  }
}

async function dismissOnboarding() {
  state.onboardingDismissed = true;
  els.onboarding.hidden = true;
  els.onboarding.replaceChildren();
  document.body.classList.remove("onboarding-active");
  await render();
}

function renderAuthPanel() {
  const ui = state.authUi;
  const card = authStateCard(ui);
  const busy = ["preparing_runtime", "signing_in", "verifying", "importing", "browser_connecting"].includes(ui.state);
  els.onboarding.innerHTML = `
    <div class="auth-atmosphere" aria-hidden="true"><i></i><i></i><i></i></div>
    <div class="auth-layout">
      <section class="auth-intro">
        <div class="auth-brand"><span class="brand-mark">g</span><strong>gramclaw</strong></div>
        <p class="eyebrow">Local Instagram memory</p>
        <h1 id="auth-title">Your Instagram,<br><em>on this machine.</em></h1>
        <p>Start with your official Meta export ZIP. Live sign-in is optional afterward — only for appending recent updates, not for downloading your history.</p>
        <div class="auth-local-note"><i></i><span><strong>Archive first.</strong> Official export is the safe way to load your library. Sync updates stay small and explicit.</span></div>
      </section>
      <section class="auth-card" aria-live="polite" aria-busy="${busy}">
        ${card}
      </section>
    </div>`;
  queueMicrotask(() => {
    const focusTarget = els.onboarding.querySelector("[data-auth-autofocus], h2");
    focusTarget?.focus?.();
  });
}

function authStateCard(ui) {
  if (ui.state === "idle") {
    return `
      <div class="auth-card-head">
        <span class="auth-step">Recommended</span>
        <h2 tabindex="-1">Import your archive</h2>
        <p>Download your Instagram information from Meta Accounts Center, then import the ZIP here. JSON or HTML exports both work.</p>
      </div>
      <button type="button" class="auth-primary" data-auth-action="import-archive" data-auth-autofocus>Import archive ZIP <span>↗</span></button>
      <ol class="auth-steps">
        <li>Accounts Center → Your information → Download your information</li>
        <li>Download the ZIP Meta sends you (JSON or HTML)</li>
        <li>Import it into Gramclaw</li>
      </ol>
      <p class="auth-privacy">Imports merge into your local SQLite library. Your password is never required for archive import.</p>
      <div class="auth-alternatives" aria-label="Optional next steps">
        <button type="button" data-auth-action="show-login">Enable update sync later (optional)</button>
        <button type="button" data-auth-action="open-workspace">Skip for now</button>
      </div>`;
  }
  if (ui.state === "import") {
    const items = ui.archives ?? [];
    const list = items.length
      ? `<ul class="auth-archive-list">${items.map((item) => {
          const selected = ui.archivePath === item.path;
          const format = item.format || "unknown";
          const label = format === "json"
            ? "JSON · ready"
            : format === "html"
              ? "HTML · ready"
              : "Unknown format";
          return `
          <li>
            <button type="button" class="${`${selected ? "selected" : ""} ${item.importable === false ? "incompatible" : ""}`.trim()}" data-auth-action="select-archive" data-path="${escapeAttr(item.path)}" data-importable="${item.importable ? "1" : "0"}" data-format="${escapeAttr(format)}">
              <strong>${escapeHtml(item.name)}</strong>
              <span>${escapeHtml(formatBytes(item.sizeBytes))} · ${escapeHtml(relativeTime(item.modifiedAt))} · ${escapeHtml(label)}</span>
            </button>
          </li>`;
        }).join("")}</ul>`
      : `<p class="auth-empty-archives">No Instagram/Meta ZIPs found in Downloads or Desktop yet. Paste a path below when your export is ready.</p>`;
    return `
      <div class="auth-card-head">
        <span class="auth-step">Import archive</span>
        <h2 tabindex="-1">Choose your ZIP</h2>
        <p>Select your Instagram export ZIP (JSON or HTML). You can also paste a path to an extracted folder.</p>
      </div>
      ${list}
      <form id="auth-import-form" class="auth-form compact">
        <label>Archive path
          <span class="auth-input"><input name="path" type="text" autocomplete="off" spellcheck="false" placeholder="/Users/you/Downloads/instagram-….zip" value="${escapeAttr(ui.archivePath)}" required data-auth-autofocus></span>
        </label>
        <button class="auth-primary" type="submit">Import archive <span>↗</span></button>
      </form>
      <div class="auth-inline-actions">
        <button type="button" data-auth-action="refresh-archives">Refresh list</button>
        <button type="button" data-auth-action="back-home">Back</button>
      </div>`;
  }
  if (ui.state === "importing") {
    return `
      <div class="auth-progress" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="auth-card-head centered">
        <span class="auth-step">Importing</span>
        <h2 tabindex="-1">Importing your archive…</h2>
        <p>${ui.archivePath ? escapeHtml(ui.archivePath.split("/").pop()) : "Reading the ZIP on this machine."} Large exports can take a minute.</p>
      </div>`;
  }
  if (ui.state === "import_error") {
    return `
      <div class="auth-error-mark" aria-hidden="true">!</div>
      <div class="auth-card-head">
        <span class="auth-step">Import could not finish</span>
        <h2 tabindex="-1">${escapeHtml(ui.errorCode === "html_export" ? "This ZIP is HTML, not JSON" : "Archive not imported")}</h2>
        <p>${escapeHtml(ui.errorMessage || "Try another export ZIP.")}</p>
      </div>
      <button type="button" class="auth-primary" data-auth-action="import-archive">Choose another ZIP <span>↗</span></button>
      <button type="button" class="auth-secondary-wide" data-auth-action="back-home">Back</button>`;
  }
  if (ui.state === "import_done") {
    const counts = ui.importResult?.counts ?? {};
    const summary = [
      counts.posts && `${formatNumber(counts.posts)} posts`,
      counts.directMessages && `${formatNumber(counts.directMessages)} DMs`,
      counts.followers && `${formatNumber(counts.followers)} followers`,
    ].filter(Boolean).join(" · ") || "Library updated";
    return `
      <div class="auth-success-profile">
        <span class="auth-archive-mark" aria-hidden="true">ZIP</span>
        <i aria-hidden="true">✓</i>
      </div>
      <div class="auth-card-head centered">
        <span class="auth-step">Archive imported</span>
        <h2 tabindex="-1">Your library is ready</h2>
        <p>${escapeHtml(summary)}. Live sync stays optional for small updates later.</p>
      </div>
      <button type="button" class="auth-primary" data-auth-action="open-workspace">Open workspace <span>↗</span></button>
      <button type="button" class="auth-secondary-wide" data-auth-action="show-login">Enable update sync (optional)</button>`;
  }
  if (ui.state === "login") {
    return `
      <div class="auth-card-head">
        <span class="auth-step">Optional · updates only</span>
        <h2 tabindex="-1">Enable update sync</h2>
        <p>Sign in in the Gramclaw login window. 2FA stays on Instagram’s official page. Everyday Chrome tabs cannot be read.</p>
      </div>
      <ol class="auth-steps">
        <li>Tap Open Instagram — a Gramclaw login window opens</li>
        <li>Sign in there, including any code or approval Instagram asks for</li>
        <li>That window can close after sign-in; Gramclaw connects automatically</li>
      </ol>
      <button type="button" class="auth-primary" data-auth-action="open-instagram" data-auth-autofocus>Open Instagram <span>↗</span></button>
      <button type="button" class="auth-secondary-wide" data-auth-action="browser-connect">I’ve signed in — continue</button>
      <p class="auth-privacy">This uses a Gramclaw login window on this computer, not your everyday Chrome cookies. The password is never stored.</p>
      <div class="auth-alternatives" aria-label="Other ways to begin">
        <button type="button" data-auth-action="import-archive">Import an archive instead</button>
        <button type="button" data-auth-action="show-password-login">Use username and password instead</button>
        <button type="button" data-auth-action="back-home">Back</button>
      </div>`;
  }
  if (ui.state === "password") {
    return `
      <div class="auth-card-head">
        <span class="auth-step">Optional · updates only</span>
        <h2 tabindex="-1">Enable update sync</h2>
        <p>Sign in only to append recent changes after your archive import. Do not use this to download your full history.</p>
      </div>
      <form id="auth-login-form" class="auth-form">
        <label>Instagram username
          <span class="auth-input"><b>@</b><input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" value="${escapeAttr(ui.username)}" required data-auth-autofocus></span>
        </label>
        <label>Password
          <span class="auth-input"><input name="password" type="password" autocomplete="current-password" required><button type="button" class="reveal-secret" data-auth-action="toggle-password" aria-label="Show password">Show</button></span>
        </label>
        <label class="risk-check"><input name="acceptRisk" type="checkbox" required><span>${escapeHtml("Direct sign-in uses Instagram's unofficial private API. Instagram may challenge or restrict accounts that use it — only continue with an account you control. Prefer your official archive for history.")}</span></label>
        <button class="auth-primary" type="submit">Enable update sync <span>↗</span></button>
      </form>
      <p class="auth-privacy">Password is discarded after sign-in. Session stays in your system keychain. Prefer Sync for small appends — not bulk history download.</p>
      <div class="auth-alternatives" aria-label="Other ways to begin">
        <button type="button" data-auth-action="import-archive">Import an archive instead</button>
        <button type="button" data-auth-action="show-login">Use a signed-in browser</button>
        <button type="button" data-auth-action="back-home">Back</button>
      </div>`;
  }
  if (ui.state === "browser_connecting") {
    return `
      <div class="auth-progress" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="auth-card-head centered">
        <span class="auth-step">Checking browser</span>
        <h2 tabindex="-1">Looking for your Instagram session…</h2>
        <p>Waiting for the Gramclaw login window. Finish sign-in there; 2FA stays on Instagram’s page.</p>
      </div>`;
  }
  if (ui.state === "preparing_runtime" || ui.state === "signing_in") {
    return `
      <div class="auth-progress-mark" aria-hidden="true"><span>g</span><i></i></div>
      <div class="auth-card-head centered">
        <span class="auth-step">Connecting</span>
        <h2 tabindex="-1">Signing in as @${escapeHtml(ui.username)}…</h2>
        <p>Instagram may ask for a code or app approval. That is normal.</p>
      </div>
      <button type="button" class="text-button auth-cancel" data-auth-action="cancel">Cancel</button>`;
  }
  if (ui.state === "verifying") {
    return `
      <div class="auth-progress" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="auth-card-head centered">
        <span class="auth-step">Almost done</span>
        <h2 tabindex="-1">Finishing connection…</h2>
        <p>Checking that update sync works. This does not use your password again.</p>
      </div>`;
  }
  if (["needs_2fa", "needs_challenge_code"].includes(ui.state)) {
    const challenge = ui.state === "needs_challenge_code";
    const destination = ui.prompt?.maskedDestination
      ? ` sent to ${escapeHtml(ui.prompt.maskedDestination)}`
      : "";
    return `
      <div class="auth-card-head">
        <span class="auth-step">${challenge ? "Instagram checkpoint" : "Two-factor authentication"}</span>
        <h2 tabindex="-1">${challenge ? "Enter the challenge code" : "Enter your one-time code"}</h2>
        <p>${challenge ? `Use the ${escapeHtml(ui.prompt?.channel ?? "email or SMS")} code${destination}.` : "Authenticator, SMS, and recovery codes are accepted."}</p>
      </div>
      <form id="auth-code-form" class="auth-form compact">
        <label>Verification code
          <span class="auth-input"><input name="code" type="password" autocomplete="one-time-code" inputmode="text" required data-auth-autofocus><button type="button" class="reveal-secret" data-auth-action="toggle-code" aria-label="Show code">Show</button></span>
        </label>
        <button class="auth-primary" type="submit">Continue <span>↗</span></button>
      </form>
      <div class="auth-inline-actions"><button type="button" data-auth-action="back">Back</button><button type="button" data-auth-action="cancel">Cancel</button></div>`;
  }
  if (ui.state === "needs_manual_approval") {
    return `
      <div class="auth-manual-mark" aria-hidden="true">↗</div>
      <div class="auth-card-head">
        <span class="auth-step">Approve in Instagram</span>
        <h2 tabindex="-1">Approve this login in Instagram</h2>
        <p>Open the official Instagram app, approve the login, then tap continue here.</p>
      </div>
      <button type="button" class="auth-primary" data-auth-action="approved">I've approved it — continue <span>↗</span></button>
      <button type="button" class="text-button auth-cancel" data-auth-action="cancel">Cancel</button>`;
  }
  if (ui.state === "success") {
    const result = ui.result;
    return `
      <div class="auth-success-profile">
        ${avatar(result.username, result.avatarUrl)}
        <i aria-hidden="true">✓</i>
      </div>
      <div class="auth-card-head centered">
        <span class="auth-step">Update sync ready</span>
        <h2 tabindex="-1">Connected as @${escapeHtml(result.username)}</h2>
        <p>${ui.result?.credentialSource === "instagrapi-session"
          ? "Session saved securely · password not saved. Use Sync for small appends after your archive."
          : "Gramclaw is using the session from the Gramclaw login window. Use Sync for small appends after your archive."}</p>
      </div>
      <button type="button" class="auth-primary" data-auth-action="sync-30">Append 30 recent posts <span>↻</span></button>
      <button type="button" class="auth-secondary-wide" data-auth-action="open-workspace">Open workspace</button>`;
  }
  const detail = authErrorCopy(ui.errorCode, ui.errorMessage);
  const sessionSaved = ui.result?.connected;
  return `
    <div class="auth-error-mark" aria-hidden="true">!</div>
    <div class="auth-card-head">
      <span class="auth-step">${sessionSaved ? "Signed in · sync check failed" : "Sign-in stopped"}</span>
      <h2 tabindex="-1">${escapeHtml(detail.title)}</h2>
      <p>${escapeHtml(detail.message)}</p>
    </div>
    ${sessionSaved ? '<button type="button" class="auth-primary" data-auth-action="verify">Try sync check again <span>↗</span></button>' : '<button type="button" class="auth-primary" data-auth-action="try-again">Try again <span>↗</span></button>'}
    <button type="button" class="auth-secondary-wide" data-auth-action="open-workspace">Open local workspace</button>`;
}

function authErrorCopy(code, fallback) {
  const copy = {
    bad_credentials: ["Instagram did not accept those details.", "Check them in the official Instagram app before trying again. Repeated attempts can trigger restrictions."],
    throttled: ["Stop here and let the account cool down.", "Instagram asked Gramclaw to wait. Do not retry repeatedly."],
    runtime_unavailable: ["Python 3.10+ is needed for direct sign-in.", "Install Python, then try again — or import an archive / use a signed-in browser."],
    keyring_unavailable: ["A secure credential store is unavailable.", "Fix your OS keychain, or use an archive / signed-in browser instead."],
    web_cookie_bridge_unavailable: ["Signed in, but live sync is not ready yet.", "Tap try again to re-check. No password needed."],
    browser_session_unavailable: ["Sign in at instagram.com first.", fallback || "Open the Gramclaw login window, finish any code or approval there, then continue."],
    manual_verification_required: ["Finish this checkpoint in Instagram.", "Use the official app or website, then reconnect."],
    session_expired: ["The saved session has expired.", "Sign in again with the same account."],
    cancelled: ["Sign-in cancelled.", "Nothing was saved."],
    protocol_error: ["Sign-in could not finish.", "Try again, or continue with an archive."],
  }[code] ?? ["Sign-in could not finish.", fallback || "Try again, or continue with your local archive."];
  return { title: copy[0], message: copy[1] };
}

async function handleAuthSubmit(event) {
  if (!["auth-login-form", "auth-code-form", "auth-import-form"].includes(event.target.id)) return;
  event.preventDefault();
  if (event.target.id === "auth-import-form") {
    const path = event.target.elements.path.value.trim();
    await runArchiveImport(path);
    return;
  }
  if (event.target.id === "auth-code-form") {
    const input = event.target.elements.code;
    let value = input.value;
    input.value = "";
    await respondToAuthPrompt(value);
    value = undefined;
    return;
  }
  const form = event.target;
  let password = form.elements.password.value;
  const username = form.elements.username.value.trim().replace(/^@/, "");
  form.elements.password.value = "";
  state.authUi = {
    ...state.authUi,
    state: "preparing_runtime",
    attemptId: null,
    prompt: null,
    username,
    result: null,
    errorCode: null,
    errorMessage: null,
  };
  renderAuthPanel();
  const progressTimer = setTimeout(() => {
    if (state.authUi.state === "preparing_runtime") {
      state.authUi.state = "signing_in";
      renderAuthPanel();
    }
  }, 900);
  let controller;
  try {
    controller = new AbortController();
    state.authController = controller;
    const request = api("/api/auth/login", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        username,
        password,
        acceptPrivateApiRisk: true,
      }),
    });
    password = undefined;
    const result = await request;
    if (controller.signal.aborted) return;
    clearTimeout(progressTimer);
    await applyAuthResponse(result);
  } catch (error) {
    clearTimeout(progressTimer);
    if (error.name === "AbortError") return;
    showAuthError(error.code, error.message);
  } finally {
    if (state.authController === controller) state.authController = null;
  }
}

async function handleAuthClick(event) {
  const element = event.target.closest("[data-auth-action]");
  if (!element) return;
  event.preventDefault();
  const action = element.dataset.authAction;
  if (action === "toggle-password" || action === "toggle-code") {
    const input = element.closest(".auth-input").querySelector("input");
    input.type = input.type === "password" ? "text" : "password";
    element.textContent = input.type === "password" ? "Show" : "Hide";
    return;
  }
  if (action === "approved") {
    await respondToAuthPrompt("continue");
  } else if (action === "cancel" || action === "back") {
    const fromPassword = ["password", "preparing_runtime", "signing_in", "needs_2fa", "needs_challenge_code", "needs_manual_approval"].includes(state.authUi.state);
    await cancelAuthAttempt();
    state.authUi.state = fromPassword ? "password" : "login";
    state.authUi.prompt = null;
    state.authUi.attemptId = null;
    renderAuthPanel();
  } else if (action === "back-home") {
    await cancelAuthAttempt();
    state.authUi.state = "idle";
    state.authUi.prompt = null;
    state.authUi.attemptId = null;
    state.authUi.errorCode = null;
    renderAuthPanel();
  } else if (action === "try-again") {
    state.authUi.state = "login";
    state.authUi.errorCode = null;
    renderAuthPanel();
  } else if (action === "open-workspace") {
    await dismissOnboarding();
  } else if (action === "import-archive") {
    state.authUi.state = "import";
    state.authUi.errorCode = null;
    renderAuthPanel();
    await loadArchiveCandidates();
  } else if (action === "refresh-archives") {
    await loadArchiveCandidates();
  } else if (action === "select-archive") {
    const path = element.dataset.path;
    const importable = element.dataset.importable === "1";
    state.authUi.archivePath = path;
    if (!importable) {
      state.authUi.state = "import_error";
      state.authUi.errorCode = "unsupported_archive";
      state.authUi.errorMessage = "That ZIP does not look like an Instagram JSON or HTML export.";
      renderAuthPanel();
      return;
    }
    renderAuthPanel();
  } else if (action === "import-path") {
    await runArchiveImport(element.dataset.path);
  } else if (action === "show-login") {
    state.authUi.state = "login";
    state.authUi.errorCode = null;
    renderAuthPanel();
  } else if (action === "show-password-login") {
    state.authUi.state = "password";
    state.authUi.errorCode = null;
    renderAuthPanel();
  } else if (action === "open-instagram") {
    await openInstagramInBrowser();
  } else if (action === "browser-connect") {
    await connectBrowserSessionUi();
  } else if (action === "sync-30") {
    await dismissOnboarding();
    els.sync.classList.add("loading");
    try {
      const result = await api("/api/sync", {
        method: "POST",
        body: JSON.stringify({ stream: "posts", mode: "cookie", limit: 30 }),
      });
      toast(`Appended ${formatNumber(result.counts?.posts ?? 0)} recent posts`);
      await refreshStatus();
      await render();
    } catch (error) {
      toast(error.message);
    } finally {
      els.sync.classList.remove("loading");
    }
  } else if (action === "verify") {
    state.authUi.state = "verifying";
    renderAuthPanel();
    await verifyConnection(true);
  }
}

async function loadArchiveCandidates() {
  try {
    const result = await api("/api/archive/find");
    state.authUi.archives = result.items ?? [];
  } catch (error) {
    state.authUi.archives = [];
    toast(error.message);
  }
  if (state.authUi.state === "import") renderAuthPanel();
}

async function openInstagramInBrowser() {
  state.authUi.state = "browser_connecting";
  state.authUi.errorCode = null;
  state.authUi.errorMessage = null;
  renderAuthPanel();
  try {
    const result = await api("/api/auth/browser/open", { method: "POST", body: "{}" });
    if (result.connected) {
      state.authUi.result = result;
      state.authUi.state = "success";
      await Promise.all([refreshStatus(), refreshAuthStatus()]);
      renderAuthPanel();
      toast(`Connected as @${result.username}`);
      return;
    }
    state.authUi.state = "login";
    renderAuthPanel();
    toast("Sign in in the Gramclaw login window, then tap continue if it does not connect automatically.");
  } catch (error) {
    showAuthError(error.code ?? "browser_session_unavailable", error.message);
    toast(error.message);
  }
}

async function connectBrowserSessionUi() {
  state.authUi.state = "browser_connecting";
  state.authUi.errorCode = null;
  state.authUi.errorMessage = null;
  renderAuthPanel();
  try {
    const result = await api("/api/auth/browser/connect", { method: "POST", body: "{}" });
    state.authUi.result = result;
    state.authUi.state = "success";
    await Promise.all([refreshStatus(), refreshAuthStatus()]);
    renderAuthPanel();
    toast(`Connected as @${result.username}`);
  } catch (error) {
    showAuthError(error.code ?? "browser_session_unavailable", error.message);
    toast(error.message);
  }
}

async function runArchiveImport(archivePath) {
  const path = String(archivePath ?? "").trim();
  if (!path) {
    toast("Choose an archive ZIP or paste its path.");
    return;
  }
  state.authUi.archivePath = path;
  state.authUi.state = "importing";
  state.authUi.errorCode = null;
  state.authUi.errorMessage = null;
  renderAuthPanel();
  try {
    const result = await api("/api/archive/import", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
    const imported = Object.values(result.counts ?? {}).reduce((sum, value) => sum + Number(value || 0), 0);
    if (!imported) {
      throw Object.assign(new Error("No Instagram data was found in that archive."), { code: "empty_archive" });
    }
    state.authUi.importResult = result;
    state.authUi.state = "import_done";
    await Promise.all([refreshStatus(), refreshAuthStatus()]);
    renderAuthPanel();
    toast(`Imported ${formatNumber(imported)} items into your local library.`);
  } catch (error) {
    const message = error.message ?? "Archive import failed.";
    state.authUi.state = "import_error";
    state.authUi.errorCode = /HTML format/i.test(message) ? "html_export" : (error.code ?? "import_failed");
    state.authUi.errorMessage = message;
    renderAuthPanel();
    toast(message);
  }
}

async function respondToAuthPrompt(value) {
  const ui = state.authUi;
  if (!ui.attemptId || !ui.prompt?.id) return;
  state.authUi.state = "signing_in";
  renderAuthPanel();
  let controller;
  try {
    controller = new AbortController();
    state.authController = controller;
    const request = api(`/api/auth/login/${encodeURIComponent(ui.attemptId)}/respond`, {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({ promptId: ui.prompt.id, value }),
    });
    value = undefined;
    const result = await request;
    if (!controller.signal.aborted) await applyAuthResponse(result);
  } catch (error) {
    if (error.name === "AbortError") return;
    showAuthError(error.code, error.message);
  } finally {
    if (state.authController === controller) state.authController = null;
  }
}

async function applyAuthResponse(result) {
  if (result.state?.startsWith("needs_")) {
    state.authUi.state = result.state;
    state.authUi.attemptId = result.attemptId;
    state.authUi.prompt = result.prompt;
    renderAuthPanel();
    return;
  }
  state.authUi.result = result;
  state.authUi.attemptId = null;
  state.authUi.prompt = null;
  if (result.connected && result.verified) {
    state.authUi.state = "success";
    await Promise.all([refreshStatus(), refreshAuthStatus()]);
    renderAuthPanel();
    return;
  }
  if (result.connected) {
    // Session is saved; finish the web-bridge check automatically so users
    // are not stuck on a manual "Verify session" dead-end.
    state.authUi.state = "verifying";
    renderAuthPanel();
    await verifyConnection(true);
    return;
  }
  state.authUi.state = "error";
  state.authUi.errorCode = result.errorCode ?? "protocol_error";
  renderAuthPanel();
}

function showAuthError(code, message) {
  state.authUi.state = "error";
  state.authUi.errorCode = code ?? "protocol_error";
  state.authUi.errorMessage = message;
  state.authUi.attemptId = null;
  state.authUi.prompt = null;
  renderAuthPanel();
}

async function cancelAuthAttempt() {
  state.authController?.abort();
  state.authController = null;
  if (!state.authUi.attemptId) return;
  try {
    await api(`/api/auth/login/${encodeURIComponent(state.authUi.attemptId)}`, {
      method: "DELETE",
    });
  } catch {
    // Expired and already-finished attempts need no additional UI error.
  }
}

function connectionInfo() {
  const direct = state.authStatus?.direct;
  if (direct?.available) {
    return {
      connected: true,
      source: "Direct sign-in",
      username: direct.username ?? state.status?.account?.username,
      detail: "Connected · session on this Mac",
      lastVerifiedAt: direct.lastVerifiedAt,
      direct: true,
    };
  }
  if (state.authStatus?.cookie?.available) {
    return {
      connected: true,
      source: "Signed-in browser",
      username: state.status?.account?.username,
      detail: "Connected · browser session",
      direct: false,
    };
  }
  if (state.authStatus?.graph?.available) {
    return {
      connected: true,
      source: "Instagram Graph",
      username: state.status?.account?.username,
      detail: "Connected · Graph credential",
      direct: false,
    };
  }
  return {
    connected: false,
    source: "No live connection",
    username: state.status?.account?.username,
    detail: "Local library available",
    direct: false,
  };
}

function renderAccountPill() {
  if (!els.accountPill) return;
  const info = connectionInfo();
  const username = info.username
    ? `@${info.username}`
    : info.connected
      ? "Instagram"
      : "Import archive";
  const detail = info.connected ? info.detail : "Archive first · sync optional";
  els.accountPill.classList.toggle("connected", info.connected);
  els.accountPill.innerHTML = `
    ${info.connected && info.username ? avatar(info.username, state.status?.account?.avatar_url) : "<span class=\"account-placeholder\">g</span>"}
    <i aria-hidden="true"></i>
    <span><strong>${escapeHtml(username)}</strong><small>${escapeHtml(detail)}</small></span>`;
}

function openConnectionDialog() {
  const info = connectionInfo();
  els.connectionContent.innerHTML = `
    <div class="connection-sheet">
      <p class="eyebrow">Library + updates</p>
      <h2 id="connection-title">${info.connected ? escapeHtml(`@${info.username ?? "Instagram"}`) : "Import archive first"}</h2>
      <p>${info.connected
        ? `${escapeHtml(info.source)} · ${escapeHtml(info.detail)}`
        : "Load your official Meta ZIP for history. Enable update sync only for small appends afterward."}</p>
      ${info.lastVerifiedAt ? `<dl><dt>Last verified</dt><dd>${escapeHtml(relativeTime(info.lastVerifiedAt))}</dd></dl>` : ""}
      <div class="connection-actions">
        ${info.connected ? '<button class="secondary-button" data-connection-action="verify">Verify session</button>' : '<button class="secondary-button" data-connection-action="import">Import archive ZIP</button>'}
        <button class="secondary-button" data-connection-action="reconnect">${info.connected ? "Reconnect" : "Enable update sync"}</button>
        ${info.direct ? '<button class="text-button danger" data-connection-action="disconnect">Disconnect</button>' : ""}
      </div>
      <p class="connection-local"><i></i> Prefer archive import for history. Live sync is for appending updates, not bulk download.</p>
    </div>`;
  els.connectionDialog.showModal();
}

async function handleConnectionAction(action) {
  if (action === "import") {
    els.connectionDialog.close();
    showOnboarding({ mode: "import" });
  } else if (action === "reconnect") {
    els.connectionDialog.close();
    showOnboarding({ mode: "login" });
  } else if (action === "verify") {
    await verifyConnection(false);
  } else if (action === "disconnect") {
    try {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
      els.connectionDialog.close();
      await refreshAuthStatus();
      toast("Disconnected on this machine; local data remains.");
      if (isEmptyWorkspace()) showOnboarding();
    } catch (error) {
      toast(error.message);
    }
  }
}

async function verifyConnection(showInOnboarding) {
  try {
    const result = await api("/api/auth/verify", { method: "POST", body: "{}" });
    await refreshAuthStatus();
    if (result.verified) {
      toast(`Verified @${result.username}`);
      if (showInOnboarding) {
        state.authUi.result = result;
        state.authUi.state = "success";
        renderAuthPanel();
      } else {
        els.connectionDialog.close();
      }
    } else if (showInOnboarding) {
      state.authUi.result = result;
      showAuthError(result.errorCode, result.message);
      toast(result.message ?? "Signed in, but live sync is not ready yet.");
    } else {
      toast(result.message ?? "Session saved, but web sync is not verified.");
    }
  } catch (error) {
    if (showInOnboarding) {
      showAuthError(error.code, error.message);
      toast(error.message);
    } else {
      toast(error.message);
    }
  }
}

async function setView(view) {
  state.view = view;
  if (view !== "boards") state.boardId = null;
  // Entering a top-level nav view is always a fresh visit: clear any
  // collection/mode filter left over from a previous Saved session so
  // Saved lands on "everything" instead of silently re-showing a stale
  // Unorganized/collection sub-view. Only the in-page Saved actions
  // (open-collection, review-unorganized, ...) should set these.
  state.collectionId = null;
  state.igCollectionId = null;
  state.libraryMode = null;
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  syncUrl();
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
    api(`/api/visual-search?saved=1&limit=500${state.collectionId ? `&collectionId=${encodeURIComponent(state.collectionId)}` : ""}${state.igCollectionId ? `&igCollectionId=${encodeURIComponent(state.igCollectionId)}` : ""}${state.libraryMode === "unorganized" ? "&unorganized=1" : ""}`),
    duplicatePromise,
  ]);
  const active = overview.collections.find((item) => item.id === state.collectionId);
  const activeIg = (overview.igCollections || []).find((item) => item.id === state.igCollectionId);
  const scoped = Boolean(active || activeIg || state.libraryMode);
  const modeTitle = state.libraryMode === "unorganized" ? "Unorganized" : state.libraryMode === "duplicates" ? "Duplicate review" : null;
  const heroTitle = modeTitle || active?.name || activeIg?.name || "Saved";
  const heroDescription = state.libraryMode === "unorganized"
    ? "Saved references that have not joined a collection or tag yet."
    : state.libraryMode === "duplicates"
      ? "Exact media fingerprints grouped for a quick visual review."
      : active
        ? escapeHtml(active.description)
        : activeIg
          ? `An Instagram Collection · ${formatNumber(activeIg.syncedItemCount)} of ${formatNumber(activeIg.mediaCount)} items synced`
          : `Everything you've saved and liked — ${formatNumber(overview.savedCount)} references, all in one place.`;
  els.content.innerHTML = `
    <section class="library-hero">
      <div>
        <p class="eyebrow">Saved</p>
        <h2>${escapeHtml(heroTitle)}</h2>
        <p>${heroDescription}</p>
      </div>
      <div class="library-actions">
        ${scoped ? '<button class="secondary-button" data-action="all-library">← All Saved</button>' : ""}
        <button class="secondary-button" data-action="create-collection">＋ Collection</button>
        <button class="sync-button" data-action="organize">✦ Organize</button>
      </div>
    </section>
    ${scoped ? "" : `
      <div class="library-stats">
        <div><strong>${formatNumber(overview.collections.length)}</strong><span>Collections</span></div>
        ${overview.igCollections?.length ? `<div><strong>${formatNumber(overview.igCollections.length)}</strong><span>Instagram Collections</span></div>` : ""}
        <div><strong>${formatNumber(overview.tags.length)}</strong><span>Tags</span></div>
        <button data-action="review-unorganized"><strong>${formatNumber(overview.unorganizedCount)}</strong><span>Unorganized →</span></button>
        <button data-action="review-duplicates"><strong>${formatNumber(overview.duplicates)}</strong><span>Duplicate groups →</span></button>
      </div>
      ${overview.igCollections?.length ? `
      <div class="section-head"><h2>Instagram Collections</h2><p>Folders synced from your own Instagram account</p></div>
      <div class="chips ig-collection-chips">${overview.igCollections.map((collection) => `<button class="chip" data-action="open-ig-collection" data-id="${escapeAttr(collection.id)}">${escapeHtml(collection.name || "Untitled")} · ${formatNumber(collection.syncedItemCount)}</button>`).join("")}</div>
      ` : ""}
      <div class="collection-grid">
        ${overview.collections.filter((item) => item.count > 0 || item.kind === "custom").map(collectionCard).join("") || emptyState("No collections yet", "Analyze your media, then organize the Saved library.")}
      </div>
      ${overview.tags.length ? `<div class="section-head"><h2>Tags</h2></div><div class="chips tag-cloud">${overview.tags.map((tag) => `<span class="tag-chip" style="--tag:${escapeAttr(tag.color)}">${escapeHtml(tag.name)} · ${tag.count}</span>`).join("")}</div>` : ""}
    `}
    ${state.libraryMode === "duplicates" ? duplicateReview(duplicates?.items || []) : `
    <div class="section-head"><h2>${escapeHtml(heroTitle)}</h2><p>Select several items for bulk organization</p></div>
    ${bulkToolbar(overview)}
    <div class="feed-grid">${savedResult.items.map((post) => postCard(post, { selectable: true })).join("") || emptyState(state.libraryMode === "unorganized" ? "Everything is organized" : "Nothing here yet", state.libraryMode === "unorganized" ? "Every Saved item belongs to a collection or tag." : "Select Saved posts and add them here.")}</div>`}`;
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
          ${board.items.length ? "" : '<div class="board-empty">Select posts in Ask or Saved, then add them to this board.</div>'}
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
        </button>`).join("") || emptyState("No boards yet", "Create one, then add visual results from Ask or Saved.")}
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
    state.igCollectionId = null;
    syncUrl();
    await renderLibrary();
  } else if (action === "open-ig-collection") {
    state.igCollectionId = element.dataset.id;
    state.collectionId = null;
    syncUrl();
    await renderLibrary();
  } else if (action === "all-library") {
    state.collectionId = null;
    state.igCollectionId = null;
    state.libraryMode = null;
    syncUrl();
    await renderLibrary();
  } else if (action === "review-unorganized") {
    state.libraryMode = "unorganized";
    state.collectionId = null;
    state.igCollectionId = null;
    syncUrl();
    await renderLibrary();
  } else if (action === "review-duplicates") {
    state.libraryMode = "duplicates";
    state.collectionId = null;
    state.igCollectionId = null;
    syncUrl();
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
    syncUrl();
    await refreshStatus();
    await renderBoards();
  } else if (action === "open-board") {
    state.boardId = element.dataset.id;
    syncUrl();
    await renderBoards();
  } else if (action === "boards-list") {
    state.boardId = null;
    state.activeBoard = null;
    els.title.textContent = viewMeta.boards[0];
    syncUrl();
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
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || payload.message || `Request failed (${response.status})`);
    error.code = payload.code || payload.errorCode || "protocol_error";
    throw error;
  }
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

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
  return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
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
