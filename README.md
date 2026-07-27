# Gramclaw

**Your Instagram, understood.** Gramclaw is a local-first Instagram visual
memory workspace inspired by Birdclaw. It turns an Instagram data export into a
private, searchable library with media analysis, natural-language visual
search, Smart Saved organization, and exportable moodboards.

The public demo uses fictional sample content and requires no Instagram login.
Your real archive stays on your own computer when you install Gramclaw.

## Privacy

This repository, the public demo, and the downloadable release do **not**
contain the maintainer's Instagram username, profile, cookies, messages, Saved
items, Liked items, or archive. Every installation creates a separate local
workspace for that user, and it reads only the data that user chooses to import
or sync from their own signed-in browser.

## See it in action

![Gramclaw hybrid visual search showing why each result matched](./public/demo-search.jpg)

Ask for a visual memory in ordinary language, combine semantic image, caption,
OCR, date, creator, color, media-type, Saved, and Liked filters, then see why
every item matched.

![Gramclaw moodboard with movable cards, notes, and export controls](./public/demo-boards.jpg)

Turn search results into moodboards, rearrange the references, add working
notes, and export the board as an image or PDF.

## What it does

| Function | What you get |
| --- | --- |
| Media analysis | Local image descriptions, OCR, colors, objects, visual style, and embeddings, with progress and retry support |
| Ask and visual search | Hybrid caption, OCR, and semantic-image retrieval with filters and transparent match explanations |
| Smart Saved Library | Automatic topic clusters, custom collections and tags, duplicate detection, and an Unorganized review queue |
| Boards | Moodboards assembled from results with manual arrangement, notes, and PNG/PDF export |
| Complete archive memory | Posts, comments, DMs, relationships, and media normalized into SQLite and searchable with FTS5 |
| Automation-ready CLI | The same local memory exposed through a JSON-first CLI, backups, caching, and guarded publishing |

## Install for yourself

Node.js 22.13 or newer is required.

### 1. Install from this repository

Clone the repository, then install its bundled release:

```bash
git clone --depth 1 https://github.com/artjing/gramclaw.git
cd gramclaw
npm install -g ./public/downloads/gramclaw-1.1.0.tgz
```

You can also choose **Code → Download ZIP** on GitHub, extract the ZIP, open a
terminal in the extracted folder, and run:

```bash
npm install -g ./public/downloads/gramclaw-1.1.0.tgz
```

Installing Gramclaw does not sign in to Instagram or include another person's
account data.

### 2. Import your own Instagram export (recommended)

To explore safely with fictional sample data:

```bash
gramclaw init --demo
gramclaw serve --open
```

For your real account, [request an export from Instagram](https://www.facebook.com/help/181231772500920):

1. In Instagram, open **Settings → Accounts Center**.
2. Open **Your information and permissions → Export your information**.
3. Choose **Create export**, select your Instagram profile, then choose
   **Export to device**.
4. Choose the information you want Gramclaw to index, select **All time**, and
   choose **JSON** as the format. Include media if you want local visual
   analysis.
5. Start the export. Instagram will notify you when it is ready; download the
   ZIP from **Available downloads**.

Keep the ZIP private and do not add it to this repository. Import it with:

```bash
gramclaw init
gramclaw import archive ~/Downloads/instagram-export.zip --json
gramclaw analyze run --provider local --json
gramclaw serve --open
```

Replace the example ZIP path with the archive you downloaded. Each person
imports their own export; no shared Gramclaw or maintainer login is involved.

### 3. Optional: refresh newer activity from your browser

**You do not need this step if the archive imported in Step 2 contains
everything you need.**

The Instagram export is a durable snapshot from the time it was created. Use
live sync only when you want to refresh newer posts, Saved items, or Liked items
without requesting another export.

After signing in to **your own Instagram account** in a supported browser on
the same computer:

```bash
gramclaw auth status --json
gramclaw sync posts --mode cookie --limit 100 --json
gramclaw sync saved --mode cookie --limit 250 --json
gramclaw sync liked --mode cookie --limit 100 --json
gramclaw serve --open
```

Gramclaw reads that local browser session on demand and does not put raw cookie
values in its database, JSON output, or backups. This optional transport uses
Instagram web endpoints that can change or be rate-limited; archive-only mode
remains the recommended, durable path.

See `gramclaw/README.md` for archive import, live adapters, guarded publishing,
private media analysis, visual search, smart Saved collections, boards, media
caching, backup, and complete CLI documentation.

## Develop the public site

The root project is the public product and demo site. The installable
application lives in `gramclaw/`.

```bash
npm install
npm run dev
npm test
npm run lint
```

The site is built with vinext for OpenAI Sites. It ships the npm tarball and
source bundle from `public/downloads/`.
