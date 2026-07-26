"use client";

import {
  ArrowDown,
  ArrowRight,
  BookMarked,
  Camera,
  Check,
  CircleDot,
  Clock3,
  Command,
  Copy,
  Database,
  Download,
  ExternalLink,
  FileArchive,
  GitBranch,
  Heart,
  LayoutGrid,
  LockKeyhole,
  Menu,
  MessageCircleMore,
  Moon,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  TerminalSquare,
  Users,
  X,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";

const previewPosts = [
  {
    author: "linh.makes",
    name: "Linh Tran",
    caption: "Glaze tests from a week of coastal fog. Keeping the failures close.",
    likes: "842",
    comments: "27",
    time: "2h",
    kind: "Post",
    palette: "p1",
  },
  {
    author: "nora.works",
    name: "Nora Singh",
    caption: "A visual system built from tide charts, shipping labels, and one stubborn shade of red.",
    likes: "1.2k",
    comments: "38",
    time: "1d",
    kind: "Carousel",
    palette: "p2",
  },
  {
    author: "kai.afterlight",
    name: "Kai Bell",
    caption: "Last light moving across the south wall. 22 seconds, no soundtrack.",
    likes: "2.3k",
    comments: "51",
    time: "3d",
    kind: "Reel",
    palette: "p3",
  },
];

const commandGroups = [
  {
    id: "search",
    label: "Ask visually",
    command: 'gramclaw ask "wooden kitchens I saved last year" --json',
    output: `{
  "items": [{
    "id": "post_8f21…",
    "score": 86,
    "why": ["Objects: wood", "Saved item"],
    "analysis": {"colors":["#9a7557"]}
  }]
}`,
  },
  {
    id: "graph",
    label: "Map people",
    command: "gramclaw graph mutuals --limit 20 --json",
    output: `{
  "followers": 18420,
  "following": 612,
  "mutuals": 284,
  "ended30d": 11
}`,
  },
  {
    id: "inbox",
    label: "Triage inbox",
    command: "gramclaw inbox --limit 8 --json",
    output: `{
  "items": [{
    "kind": "dm",
    "score": 92,
    "text": "Can we discuss a project?"
  }]
}`,
  },
  {
    id: "backup",
    label: "Back it up",
    command: "gramclaw backup sync --repo ~/Backups/gramclaw",
    output: `{
  "ok": true,
  "committed": true,
  "format": "gramclaw-jsonl",
  "secretsIncluded": false
}`,
  },
];

const faqItems = [
  {
    question: "Does Gramclaw upload my archive?",
    answer:
      "No. The app imports into SQLite and analyzes media on your machine. The public site never receives your archive, images, messages, cookies, or tokens. Optional cloud vision runs only when you explicitly choose it.",
  },
  {
    question: "Do I need an Instagram API key?",
    answer:
      "No for archive import, search, DMs, insights, media preservation, backups, and the local web workspace. Optional live reads can reuse your signed-in browser session. Professional accounts can also connect the official Instagram Graph API.",
  },
  {
    question: "What can it import?",
    answer:
      "JSON exports containing posts, carousels, reels, stories, comments, likes, saved posts, followers, following, profile information, and direct-message history. Imports are idempotent and merge-safe.",
  },
  {
    question: "Can agents use it?",
    answer:
      "Yes. Every read path has stable JSON output: visual search, media analysis, Saved collections, boards, conversations, profiles, relationship graphs, and insights.",
  },
  {
    question: "Can it publish?",
    answer:
      "Yes, with guardrails. Browser-cookie transport supports a local JPEG post or story. The official Graph transport supports URL-based posts, carousels, reels, stories, comments, replies, and messages. Writes remain drafts unless you explicitly pass --yes.",
  },
];

type PreviewTab = "Home" | "Ask" | "Library" | "Boards";

const previewNav: { label: PreviewTab; Icon: LucideIcon }[] = [
  { label: "Home", Icon: LayoutGrid },
  { label: "Ask", Icon: Search },
  { label: "Library", Icon: BookMarked },
  { label: "Boards", Icon: Sparkles },
];

const commandMatrix: { title: string; detail: string; Icon: LucideIcon }[] = [
  { title: "Archive", detail: "import · find · restore", Icon: FileArchive },
  { title: "Visual memory", detail: "OCR · objects · colors · embeddings", Icon: Sparkles },
  { title: "Conversations", detail: "dms · inbox · comments", Icon: MessageCircleMore },
  { title: "People", detail: "profiles · mutuals · events", Icon: Users },
  { title: "Organize", detail: "clusters · tags · boards · exports", Icon: LayoutGrid },
  { title: "Actions", detail: "draft · post · comment · dm", Icon: Zap },
];

function ProductPreview() {
  const [tab, setTab] = useState<PreviewTab>("Home");

  return (
    <div className="product-window" aria-label="Interactive Gramclaw product preview">
      <div className="window-top">
        <div className="traffic-lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <div className="window-location">
          <LockKeyhole size={11} />
          <span>127.0.0.1:4667</span>
        </div>
        <span className="local-dot">Local</span>
      </div>
      <div className="product-shell">
        <aside className="preview-sidebar">
          <div className="preview-brand">
            <span>g</span>
            <strong>gramclaw</strong>
          </div>
          {previewNav.map(({ label, Icon }) => (
            <button
              key={label}
              className={tab === label ? "selected" : ""}
              onClick={() => setTab(label)}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
          <div className="preview-private">
            <i />
            On this Mac
          </div>
        </aside>
        <div className="preview-main">
          <div className="preview-heading">
            <div>
              <span>PERSONAL ARCHIVE</span>
              <h3>{tab}</h3>
            </div>
            <div className="preview-search">
              <Search size={13} />
              {tab === "Ask" ? "wooden interiors I saved…" : "Search"}
            </div>
          </div>

          {tab === "Home" || tab === "Ask" ? (
            <div className="preview-grid">
              {previewPosts
                .filter((_, index) => tab === "Home" || index !== 0)
                .map((post) => (
                  <article className="preview-post" key={post.author}>
                    <div className={`preview-media ${post.palette}`}>
                      <span>{post.kind}</span>
                    </div>
                    <div className="preview-post-copy">
                      <div className="preview-author">
                        <i>{post.author.slice(0, 2).toUpperCase()}</i>
                        <div>
                          <strong>@{post.author}</strong>
                          <small>{post.name}</small>
                        </div>
                      </div>
                      <p>{post.caption}</p>
                      <footer>
                        <span>
                          <Heart size={10} /> {post.likes}
                        </span>
                        <span>
                          <MessageCircleMore size={10} /> {post.comments}
                        </span>
                        <time>{tab === "Ask" ? "✓ visual match" : post.time}</time>
                      </footer>
                    </div>
                  </article>
                ))}
            </div>
          ) : tab === "Library" ? (
            <div className="preview-collections">
              {[
                ["Interiors", "42 items", "p1"],
                ["Ceramics", "28 items", "p3"],
                ["Graphic design", "61 items", "p2"],
                ["Unorganized", "13 items", "p4"],
              ].map(([name, count, palette]) => (
                <div className={`preview-collection ${palette}`} key={name}>
                  <span>Automatic</span>
                  <strong>{name}</strong>
                  <small>{count}</small>
                </div>
              ))}
            </div>
          ) : (
            <div className="preview-board">
              {previewPosts.map((post, index) => (
                <article className={`board-paper board-paper-${index}`} key={post.author}>
                  <div className={`preview-media ${post.palette}`} />
                  <strong>@{post.author}</strong>
                  <small>{["Keep the quiet texture.", "Borrow this red.", "Warm evening light."][index]}</small>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function GramclawSite() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const [activeCommand, setActiveCommand] = useState(commandGroups[0]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem("gramclaw-site-theme");
    const shouldDark =
      stored === "dark" ||
      (!stored && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const frame = window.requestAnimationFrame(() => setDark(shouldDark));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.siteTheme = dark ? "dark" : "light";
  }, [dark]);

  async function copyCommand(command: string) {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    window.localStorage.setItem("gramclaw-site-theme", next ? "dark" : "light");
  }

  return (
    <main className="site">
      <header className="site-nav">
        <a className="site-logo" href="#top" aria-label="Gramclaw home">
          <span>g</span>
          <strong>gramclaw</strong>
          <em>v1.1</em>
        </a>
        <nav className={menuOpen ? "open" : ""} aria-label="Primary navigation">
          <a href="#workspace" onClick={() => setMenuOpen(false)}>
            Workspace
          </a>
          <a href="#features" onClick={() => setMenuOpen(false)}>
            Features
          </a>
          <a href="#cli" onClick={() => setMenuOpen(false)}>
            CLI
          </a>
          <a href="#safety" onClick={() => setMenuOpen(false)}>
            Safety
          </a>
          <a href="#faq" onClick={() => setMenuOpen(false)}>
            FAQ
          </a>
        </nav>
        <div className="nav-actions">
          <button className="theme-button" onClick={toggleTheme} aria-label="Toggle color theme">
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <a className="nav-download" href="/downloads/gramclaw-1.1.0.tgz" download>
            Download <ArrowDown size={14} />
          </a>
          <button
            className="menu-button"
            onClick={() => setMenuOpen((value) => !value)}
            aria-label="Toggle menu"
            aria-expanded={menuOpen}
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-glow" aria-hidden="true" />
        <div className="hero-copy">
          <div className="hero-kicker">
            <span>
              <CircleDot size={12} /> Local-first
            </span>
            <span>Instagram memory</span>
            <span>Agent-ready</span>
          </div>
          <h1>
            Your Instagram history.
            <br />
            <i>Actually yours.</i>
          </h1>
          <p>
            Import your archive into private local SQLite. Ask for images in natural
            language, search OCR and visual concepts, organize Saved posts
            automatically, and build exportable moodboards.
          </p>
          <div className="hero-actions">
            <a className="button-primary" href="/downloads/gramclaw-1.1.0.tgz" download>
              <Download size={17} />
              Download Gramclaw
              <span>macOS · Linux · Windows</span>
            </a>
            <a className="button-secondary" href="#quickstart">
              See quickstart <ArrowRight size={16} />
            </a>
          </div>
          <div className="hero-proof">
            <span>
              <Check size={13} /> No cloud database
            </span>
            <span>
              <Check size={13} /> Local analysis by default
            </span>
            <span>
              <Check size={13} /> MIT licensed
            </span>
          </div>
        </div>
        <div className="hero-visual" id="workspace">
          <div className="preview-orbit orbit-one" aria-hidden="true" />
          <div className="preview-orbit orbit-two" aria-hidden="true" />
          <ProductPreview />
          <div className="floating-chip chip-sqlite">
            <Database size={14} />
            SQLite is truth
          </div>
          <div className="floating-chip chip-private">
            <ShieldCheck size={14} />
            Loopback only
          </div>
        </div>
      </section>

      <section className="ticker" aria-label="Supported Instagram data">
        <div>
          <span>Posts</span>
          <i>✦</i>
          <span>Carousels</span>
          <i>✦</i>
          <span>Reels</span>
          <i>✦</i>
          <span>Stories</span>
          <i>✦</i>
          <span>Comments</span>
          <i>✦</i>
          <span>DMs</span>
          <i>✦</i>
          <span>Saved</span>
          <i>✦</i>
          <span>Likes</span>
          <i>✦</i>
          <span>Followers</span>
          <i>✦</i>
          <span>Visual search</span>
          <i>✦</i>
          <span>OCR</span>
          <i>✦</i>
          <span>Boards</span>
        </div>
      </section>

      <section className="quickstart section-pad" id="quickstart">
        <div className="section-label">
          <span>01</span> Start in a minute
        </div>
        <div className="quickstart-grid">
          <div className="quickstart-copy">
            <h2>One archive in. A whole memory system out.</h2>
            <p>
              Request a JSON export from Instagram Accounts Center, point Gramclaw at
              the ZIP, and open the local workspace. Re-import later—merges are
              idempotent and preserve newer local data.
            </p>
            <a
              href="https://www.facebook.com/help/instagram/181231772500920"
              target="_blank"
              rel="noreferrer"
            >
              How to export from Instagram <ExternalLink size={13} />
            </a>
          </div>
          <div className="terminal-card">
            <div className="terminal-bar">
              <div>
                <i />
                <i />
                <i />
              </div>
              <span>Terminal</span>
              <button
                onClick={() =>
                  copyCommand(
                    "npm install -g ./gramclaw-1.1.0.tgz\ngramclaw import archive ~/Downloads/instagram-export.zip\ngramclaw analyze run\ngramclaw serve --open",
                  )
                }
                aria-label="Copy quickstart commands"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            <pre>
              <code>
                <span className="comment"># Install the downloaded release</span>
                {"\n"}
                <span className="prompt">$</span> npm install -g ./gramclaw-1.1.0.tgz
                {"\n\n"}
                <span className="comment"># Build your local memory</span>
                {"\n"}
                <span className="prompt">$</span> gramclaw import archive ~/Downloads/instagram-export.zip
                {"\n"}
                <span className="success">✓ 4,218 posts · 12,904 DMs · 1,103 saved</span>
                {"\n\n"}
                <span className="comment"># Build the private visual index</span>
                {"\n"}
                <span className="prompt">$</span> gramclaw analyze run
                {"\n"}
                <span className="success">✓ OCR · objects · colors · embeddings</span>
                {"\n\n"}
                <span className="prompt">$</span> gramclaw serve --open
                {"\n"}
                <span className="success">→ http://127.0.0.1:4667</span>
              </code>
            </pre>
          </div>
        </div>
      </section>

      <section className="features section-pad" id="features">
        <div className="section-label">
          <span>02</span> A working memory, not a dashboard
        </div>
        <div className="section-heading">
          <h2>Instagram is the source. Your machine is the home.</h2>
          <p>
            Archive and live transports converge on one normalized local core, so
            the interface, CLI, backups, and agents all see the same truth.
          </p>
        </div>
        <div className="feature-grid">
          <article className="feature-card feature-large card-lime">
            <div className="feature-icon">
              <FileArchive size={22} />
            </div>
            <span className="feature-number">01</span>
            <h3>Private media understanding</h3>
            <p>
              Local OCR, image descriptions, dominant colors, objects, visual style,
              embeddings, and duplicate fingerprints—with progress and retry support.
            </p>
            <div className="format-stack" aria-hidden="true">
              {["OCR + objects", "palette + style", "visual embedding"].map((name, index) => (
                <div key={name} style={{ "--index": index } as React.CSSProperties}>
                  <FileArchive size={15} />
                  {name}
                  <Check size={13} />
                </div>
              ))}
              <ArrowDown size={18} />
              <div className="sqlite-pill">
                <Database size={16} /> private visual index
              </div>
            </div>
          </article>
          <article className="feature-card">
            <div className="feature-icon">
              <Search size={22} />
            </div>
            <span className="feature-number">02</span>
            <h3>Ask what you remember</h3>
            <p>Hybrid caption, OCR, metadata, and semantic-image search with creator, date, type, Saved/Liked, color, and topic filters.</p>
            <div className="mini-search">
              <Search size={13} />
              wooden kitchens I saved
              <kbd>⌘ K</kbd>
            </div>
            <div className="mini-result">
              <i>NS</i>
              <p>
                <mark>Wood</mark> · warm interior · last year
              </p>
              <span>Saved</span>
            </div>
          </article>
          <article className="feature-card">
            <div className="feature-icon">
              <BookMarked size={22} />
            </div>
            <span className="feature-number">03</span>
            <h3>Saved, automatically organized</h3>
            <p>Topic clusters and a review queue sit beside your own collections, tags, and bulk organization tools.</p>
            <div className="score-list">
              {[
                ["42", "Interiors", "Wood, kitchens, quiet rooms"],
                ["28", "Ceramics", "Glaze, clay, studio tests"],
                ["13", "Unorganized", "Ready for your review"],
              ].map(([score, label, text]) => (
                <div key={score}>
                  <strong>{score}</strong>
                  <p>
                    <span>{label}</span>
                    {text}
                  </p>
                </div>
              ))}
            </div>
          </article>
          <article className="feature-card feature-wide card-violet">
            <div className="feature-icon">
              <LayoutGrid size={22} />
            </div>
            <span className="feature-number">04</span>
            <div className="wide-copy">
              <h3>Build a board while the idea is alive</h3>
              <p>
                Pull references directly from search, rearrange them freely, add
                working notes, and export the finished moodboard as an image or PDF.
              </p>
            </div>
            <div className="relationship-visual board-feature-visual" aria-hidden="true">
              {previewPosts.map((post, index) => (
                <div className={`feature-board-paper feature-board-paper-${index}`} key={post.author}>
                  <span className={post.palette} />
                  <strong>@{post.author}</strong>
                  <small>{["Keep this texture.", "Borrow the red.", "Warm evening light."][index]}</small>
                </div>
              ))}
            </div>
          </article>
          <article className="feature-card">
            <div className="feature-icon">
              <GitBranch size={22} />
            </div>
            <span className="feature-number">05</span>
            <h3>Backups you can inspect</h3>
            <p>
              Deterministic JSONL shards stay Git-friendly. Cookies, tokens, WAL files,
              FTS shadow tables, and downloaded media stay out.
            </p>
            <div className="tree">
              <span>manifest.json</span>
              <span>data/posts.jsonl</span>
              <span>data/dms/messages.jsonl</span>
              <span>data/network/events.jsonl</span>
            </div>
          </article>
          <article className="feature-card card-coral">
            <div className="feature-icon">
              <Clock3 size={22} />
            </div>
            <span className="feature-number">06</span>
            <h3>Ephemeral, preserved</h3>
            <p>
              Stories and archive media are copied into your local originals cache,
              with live downloads paced separately.
            </p>
            <div className="story-rings">
              {["A", "N", "K", "P"].map((name, index) => (
                <i key={name} style={{ "--story": index } as React.CSSProperties}>
                  {name}
                </i>
              ))}
            </div>
          </article>
        </div>
      </section>

      <section className="cli-section section-pad" id="cli">
        <div className="section-label section-label-light">
          <span>03</span> Claw-ready from day one
        </div>
        <div className="cli-grid">
          <div className="cli-copy">
            <div className="cli-mark">
              <TerminalSquare size={22} />
            </div>
            <h2>Human-friendly in the browser. Agent-native in the terminal.</h2>
            <p>
              Every read command emits stable JSON. Your scripts and agents can search,
              triage, inspect people, read conversations, and analyze the relationship
              graph without touching Instagram again.
            </p>
            <div className="command-tabs" role="tablist" aria-label="Command examples">
              {commandGroups.map((group) => (
                <button
                  key={group.id}
                  role="tab"
                  aria-selected={activeCommand.id === group.id}
                  className={activeCommand.id === group.id ? "active" : ""}
                  onClick={() => setActiveCommand(group)}
                >
                  {group.label}
                </button>
              ))}
            </div>
          </div>
          <div className="code-window">
            <div className="code-top">
              <span>
                <Command size={12} /> gramclaw
              </span>
              <button onClick={() => copyCommand(activeCommand.command)}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <pre>
              <code>
                <span className="prompt">$</span> {activeCommand.command}
                {"\n\n"}
                <span className="json-output">{activeCommand.output}</span>
              </code>
            </pre>
          </div>
        </div>
        <div className="command-matrix">
          {commandMatrix.map(({ title, detail, Icon }) => (
            <div key={title}>
              <Icon size={17} />
              <strong>{title}</strong>
              <span>{detail}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="safety section-pad" id="safety">
        <div className="section-label">
          <span>04</span> Private by architecture
        </div>
        <div className="safety-shell">
          <div className="safety-copy">
            <div className="shield-orbit">
              <ShieldCheck size={38} />
              <i />
            </div>
            <h2>Your archive never needs a cloud.</h2>
            <p>
              The durable path is deliberately boring: JSON export → local SQLite →
              loopback web app. Live connections are optional adapters, never the
              canonical store.
            </p>
            <div className="safety-checks">
              {[
                "Binds to 127.0.0.1 by default",
                "Writes stay drafts until --yes",
                "Browser cookies never enter backups",
                "Optional app token for local web",
                "No remote AI required",
                "Archive-only mode always works",
              ].map((item) => (
                <span key={item}>
                  <Check size={13} /> {item}
                </span>
              ))}
            </div>
          </div>
          <div className="transport-card">
            <div className="transport-head">
              <Sparkles size={15} />
              Optional live transport
            </div>
            <div className="transport-row">
              <div>
                <Camera size={17} />
                <span>
                  <strong>Instagram archive</strong>
                  Durable, complete, keyless
                </span>
              </div>
              <em className="recommended">Recommended</em>
            </div>
            <div className="transport-row">
              <div>
                <CircleDot size={17} />
                <span>
                  <strong>Browser session</strong>
                  Personal account reads + guarded actions
                </span>
              </div>
              <em>Best effort</em>
            </div>
            <div className="transport-row">
              <div>
                <ShieldCheck size={17} />
                <span>
                  <strong>Instagram Graph</strong>
                  Professional account publishing
                </span>
              </div>
              <em>Official API</em>
            </div>
            <p>
              Private web endpoints can change or rate-limit automation. Gramclaw
              surfaces transport health without making live access a dependency.
            </p>
          </div>
        </div>
      </section>

      <section className="faq section-pad" id="faq">
        <div className="section-label">
          <span>05</span> Before you download
        </div>
        <div className="faq-grid">
          <div>
            <h2>Good questions.<br />Plain answers.</h2>
            <p>
              Gramclaw is independent software, not affiliated with Instagram or Meta.
              Use live access gently and only on accounts you control.
            </p>
          </div>
          <div className="faq-list">
            {faqItems.map((item) => (
              <details key={item.question}>
                <summary>
                  {item.question}
                  <span>+</span>
                </summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="final-cta">
        <div className="cta-noise" aria-hidden="true" />
        <div className="cta-mark">g</div>
        <p>Local-first Instagram memory</p>
        <h2>Stop renting access<br />to your own history.</h2>
        <div className="hero-actions">
          <a className="button-primary" href="/downloads/gramclaw-1.1.0.tgz" download>
            <Download size={17} />
            Download v1.1
          </a>
          <a className="button-secondary button-on-dark" href="/downloads/gramclaw-source.zip" download>
            Source bundle <ArrowRight size={16} />
          </a>
        </div>
        <span className="cta-note">Node 22+ · MIT · macOS, Linux, Windows</span>
      </section>

      <footer className="site-footer">
        <div className="site-logo footer-logo">
          <span>g</span>
          <strong>gramclaw</strong>
        </div>
        <p>
          Inspired by Birdclaw’s local-first model. Built for Instagram’s native
          objects and archives.
        </p>
        <div>
          <a href="#top">Top</a>
          <a href="/downloads/gramclaw-1.1.0.tgz" download>
            Release
          </a>
          <a href="/downloads/gramclaw-source.zip" download>
            Source
          </a>
        </div>
      </footer>
    </main>
  );
}
