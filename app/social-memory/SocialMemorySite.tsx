"use client";

import {
  ArrowRight,
  BrainCircuit,
  Check,
  CircleDot,
  Compass,
  FileOutput,
  LockKeyhole,
  Search,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

const sources = [
  "Instagram",
  "YouTube",
  "TikTok",
  "Pinterest",
  "X",
  "LinkedIn",
  "Threads",
  "Reddit",
  "Are.na",
  "Your files",
];

const memories = [
  { title: "Translucent shell chair", note: "Instagram · Saved May 18, 2024", reason: "92% · shape + material", color: "lime" },
  { title: "Shiro Kuramata interview", note: "YouTube · Watched May 11, 2024", reason: "88% · spoken reference", color: "violet" },
  { title: "Tokyo material diary", note: "Pinterest · Saved Apr 29, 2024", reason: "84% · trip timing", color: "coral" },
];

const steps = [
  { number: "01", title: "Bring your history", body: "Start with official exports from Instagram and YouTube. Add another source only when you choose." },
  { number: "02", title: "Search one memory", body: "Describe the image, phrase, person, time, or feeling you remember. The result always links back to its source." },
  { number: "03", title: "Make something", body: "Open a project and turn selected memories into a moodboard, creative brief, reference list, or first draft." },
];

const outcomes = [
  {
    number: "01",
    title: "Find what you remember, not where it was",
    body: "Ask in ordinary language. Social Memory searches meaning, images, spoken words, captions, creators, and time across every connected archive.",
    example: '“That translucent chair I saved before my Tokyo trip.”',
    icon: Search,
  },
  {
    number: "02",
    title: "See the taste you have been building",
    body: "It groups recurring colors, forms, people, places, and ideas into a personal taste map that changes with you.",
    example: "Your visual language: soft industrial · saturated red · tactile type",
    icon: Compass,
  },
  {
    number: "03",
    title: "Turn memory into a new result",
    body: "Start with a goal. Your private agent retrieves the right references, explains the pattern, and helps create a brief, moodboard, itinerary, or first draft.",
    example: "Build a launch direction from my strongest saved references.",
    icon: WandSparkles,
  },
];

export function SocialMemorySite() {
  const [query, setQuery] = useState("the translucent chair I saved before my Tokyo trip");

  return (
    <main className="memory-site">
      <header className="memory-nav">
        <span className="memory-nav-label">PRIVATE MEMORY / PRODUCT CONCEPT</span>
        <a href="#top" className="memory-wordmark"><span>ml</span> Memory Layer <em>working concept</em></a>
        <a href="#product" className="memory-nav-cta">Explore the product <ArrowRight size={14} /></a>
      </header>

      <section className="memory-hero" id="top">
        <div className="memory-eyebrow"><CircleDot size={12} /> A private search engine for your own history</div>
        <h1>Find what you remember.<br /><i>Use it again.</i></h1>
        <p>Bring in the posts and videos you chose to keep. Search across platforms in ordinary language, see why each result matched, and turn your memories into new work.</p>
        <div className="memory-source-row" aria-label="Planned sources">
          {sources.map((source) => <span key={source}>{source}</span>)}
        </div>

        <div className="memory-workspace" id="product">
          <aside>
            <div className="memory-logo"><span>ml</span><strong>Memory Layer</strong></div>
            <nav>
              <a className="active"><BrainCircuit size={15} /> Recall</a>
              <a><Sparkles size={15} /> Taste map</a>
              <a><WandSparkles size={15} /> Create</a>
              <a><FileOutput size={15} /> Projects</a>
            </nav>
            <div className="memory-private"><LockKeyhole size={13} /><span><strong>Private by default</strong>Your sources stay separated.</span></div>
          </aside>
          <div className="memory-canvas">
            <div className="memory-canvas-head"><span>FIND A MEMORY</span><small>12,840 items · 3 connected sources</small></div>
            <label className="memory-query"><Search size={19} /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Try a memory search" /><kbd>↵</kbd></label>
            <div className="memory-answer">
              <p>I found three likely matches. The strongest result combines <b>translucent material, a chair silhouette, and items saved before your May 2024 Tokyo trip.</b></p>
              <div className="memory-cards">
                {memories.map((memory) => <article className={memory.color} key={memory.title}><div /><span>{memory.reason}</span><strong>{memory.title}</strong><small>{memory.note}</small></article>)}
              </div>
              <div className="memory-next"><span>Turn this into</span><button>Moodboard</button><button>Creative brief</button><button>Reference list</button></div>
            </div>
          </div>
        </div>
      </section>

      <section className="memory-how" id="how-it-works">
        <header><span>THE FIRST PRODUCT</span><h2>One job, end to end.</h2><p>Start with the moment everyone knows: “I saved it somewhere, but I cannot find it.”</p></header>
        <div className="memory-how-grid">
          {steps.map((step) => <article key={step.number}><b>{step.number}</b><h3>{step.title}</h3><p>{step.body}</p></article>)}
        </div>
        <div className="memory-connect-panel">
          <div><span>YOUR SOURCES</span><h3>Connect only what you want remembered.</h3><p>Official archives are the safe starting point. Each imported item keeps its platform, creator, date, and original link.</p></div>
          <div className="memory-source-list">
            <div><strong>Instagram archive</strong><span>4,820 saved posts · Ready</span><em>Connected</em></div>
            <div><strong>YouTube history</strong><span>2,104 videos · Ready</span><em>Connected</em></div>
            <div><strong>TikTok data export</strong><span>Favorites, likes, and history</span><button>Add source</button></div>
            <div><strong>Pinterest export</strong><span>Boards, pins, and links</span><button>Add source</button></div>
            <div><strong>X archive</strong><span>Bookmarks, likes, and posts</span><button>Add source</button></div>
            <div><strong>LinkedIn archive</strong><span>Saved posts, connections, and activity</span><button>Add source</button></div>
          </div>
        </div>
      </section>

      <section className="memory-promise">
        <span>THE CORE PROMISE</span>
        <h2>Your history should become useful context — not another feed to manage.</h2>
        <div className="memory-trust"><div><Check size={15} /> You choose each source</div><div><Check size={15} /> Personal agents need permission</div><div><Check size={15} /> Export or delete your memory</div></div>
      </section>

      <section className="memory-outcomes">
        <header><span>WHAT IT DOES</span><h2>From scattered saves<br />to finished work.</h2><p>The first product focuses on three jobs people already struggle to do.</p></header>
        <div>
          {outcomes.map(({ number, title, body, example, icon: Icon }) => <article key={number}><span>{number}</span><Icon size={25} /><h3>{title}</h3><p>{body}</p><blockquote>{example}</blockquote></article>)}
        </div>
      </section>

      <section className="memory-project">
        <div className="memory-project-copy"><span>CREATIVE MEMORY AGENT</span><h2>Start with a goal, not an empty prompt.</h2><p>Tell the agent what you are making, who it is for, and what success looks like. It retrieves the most relevant parts of your history, finds the taste behind them, and builds an editable creative system.</p><blockquote>“Create the visual direction and launch content for a small jewelry brand from my strongest saved references.”</blockquote><ul><li><Check size={13} /> Choose which platforms and memories it may use</li><li><Check size={13} /> Keep every recommendation linked to its source</li><li><Check size={13} /> Refine direction without losing your personal taste</li></ul></div>
        <div className="memory-project-ui">
          <header><span>PROJECT / ORBIT JEWELRY</span><em>Creative agent · 34 memories</em></header>
          <h3>Soft industrial, made personal.</h3>
          <div className="memory-project-tags"><span>Brushed metal</span><span>Warm shadow</span><span>Handmade type</span><span>Quiet ritual</span></div>
          <div className="memory-agent-steps"><span><b>1</b> Retrieve</span><span><b>2</b> Find patterns</span><span><b>3</b> Build direction</span><span><b>4</b> Produce</span></div>
          <div className="memory-project-output"><div><b>01</b><strong>Moodboard</strong><small>12 cited references</small></div><div><b>02</b><strong>Creative brief</strong><small>Audience, tone, direction</small></div><div><b>03</b><strong>Visual system</strong><small>Palette, type, materials</small></div><div><b>04</b><strong>Reel storyboard</strong><small>6 scenes with references</small></div><div><b>05</b><strong>Shot list</strong><small>8 launch concepts</small></div><div><b>06</b><strong>Launch copy</strong><small>Captions in your voice</small></div></div>
          <p>Every suggestion shows the memories that shaped it. Nothing is published without you.</p>
        </div>
      </section>

      <section className="memory-architecture">
        <div><span>ONE MEMORY, MANY USES</span><h2>A personal context layer your agents can work with.</h2><p>Every source becomes a permissioned memory object with provenance. Search it yourself, or let an agent retrieve only the context needed for a task.</p></div>
        <ol><li><b>01</b><strong>Collect</strong><span>Official exports, browser saves, and user-connected sources</span></li><li><b>02</b><strong>Understand</strong><span>Text, visuals, audio, people, topics, and relationships</span></li><li><b>03</b><strong>Act</strong><span>Recall, organize, recommend, draft, and create</span></li></ol>
      </section>

      <section className="memory-boundary">
        <div><LockKeyhole size={24} /><span>PRIVATE BY DESIGN</span><h2>Your memory is not a social feed.</h2><p>Sources stay private and separated. You decide what is imported, what an AI model may analyze, what another agent may retrieve, and when everything is deleted.</p></div>
        <div><BrainCircuit size={24} /><span>AGENT READY</span><h2>Useful wherever you create.</h2><p>With explicit permission, ChatGPT, Claude, Cursor, or another tool can ask for the few memories needed for a task through MCP—without receiving your entire history.</p></div>
      </section>

      <section className="memory-case" id="case-study">
        <div className="memory-case-kicker">LIVE OPEN-SOURCE CASE / 01</div>
        <div className="memory-case-copy">
          <span>GRAMCLAW</span>
          <h2>One platform, made into a memory you own.</h2>
          <p>Gramclaw is the open-source Instagram case study for this product direction. It imports an official Instagram archive, keeps it on the user&apos;s machine, and turns posts, media, Reels, and history into a searchable visual memory.</p>
          <ul>
            <li><Check size={13} /> Local-first and open source</li>
            <li><Check size={13} /> Real archive ingestion and completeness reporting</li>
            <li><Check size={13} /> A proving ground for visual search and permissioned agents</li>
          </ul>
          <Link href="/">Explore the Gramclaw case <ArrowRight size={14} /></Link>
        </div>
        <div className="memory-case-card">
          <span>CASE STUDY</span><strong>Your Instagram,<br /><i>on this machine.</i></strong>
          <p>From a platform export to a private visual memory.</p>
          <div><b>01</b> Import archive</div><div><b>02</b> Search history</div><div><b>03</b> Use with an agent</div>
        </div>
      </section>

      <footer className="memory-footer"><span>Memory Layer</span><p>Working concept · name, interface, and scope are still being designed.</p><a href="#top">Back to top ↑</a></footer>
    </main>
  );
}
