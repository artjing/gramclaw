"use client";

import {
  ArrowRight,
  BrainCircuit,
  Check,
  ChevronLeft,
  CircleDot,
  Compass,
  FileOutput,
  LockKeyhole,
  Search,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { useState } from "react";

const sources = ["Instagram", "YouTube", "TikTok", "Pinterest", "X", "Your files"];

const memories = [
  { title: "Quiet interiors", note: "Saved across 4 platforms", color: "lime" },
  { title: "Kinetic type", note: "18 references · 3 years", color: "violet" },
  { title: "Future rituals", note: "Videos, notes, and posts", color: "coral" },
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
  const [query, setQuery] = useState("warm spaces with unusual materials");

  return (
    <main className="memory-site">
      <header className="memory-nav">
        <a href="/" className="memory-back"><ChevronLeft size={15} /> Gramclaw</a>
        <a href="#top" className="memory-wordmark"><span>ml</span> Memory Layer <em>working concept</em></a>
        <a href="#product" className="memory-nav-cta">Explore the product <ArrowRight size={14} /></a>
      </header>

      <section className="memory-hero" id="top">
        <div className="memory-eyebrow"><CircleDot size={12} /> Private memory layer for your social life</div>
        <h1>Your life across the internet,<br /><i>remembered.</i></h1>
        <p>Bring years of saved posts, watched videos, likes, follows, notes, and archives into one private memory. Then ask it to find, connect, and create.</p>
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
            <div className="memory-canvas-head"><span>ASK YOUR MEMORY</span><small>12,840 items indexed</small></div>
            <label className="memory-query"><Search size={19} /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Try a memory search" /><kbd>↵</kbd></label>
            <div className="memory-answer">
              <p>I found a strong pattern around <b>warm light, raw stone, translucent surfaces, and curved seating.</b> Most references were saved during your 2024 travel planning.</p>
              <div className="memory-cards">
                {memories.map((memory) => <article className={memory.color} key={memory.title}><div /><span>MEMORY CLUSTER</span><strong>{memory.title}</strong><small>{memory.note}</small></article>)}
              </div>
              <div className="memory-next"><span>Turn this into</span><button>Moodboard</button><button>Creative brief</button><button>Reference list</button></div>
            </div>
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

      <section className="memory-architecture">
        <div><span>ONE MEMORY, MANY USES</span><h2>A personal context layer your agents can work with.</h2><p>Every source becomes a permissioned memory object with provenance. Search it yourself, or let an agent retrieve only the context needed for a task.</p></div>
        <ol><li><b>01</b><strong>Collect</strong><span>Official exports, browser saves, and user-connected sources</span></li><li><b>02</b><strong>Understand</strong><span>Text, visuals, audio, people, topics, and relationships</span></li><li><b>03</b><strong>Act</strong><span>Recall, organize, recommend, draft, and create</span></li></ol>
      </section>

      <footer className="memory-footer"><a href="/">gramclaw.website</a><p>Working concept · name, interface, and scope are still being designed.</p><a href="#top">Back to top ↑</a></footer>
    </main>
  );
}
