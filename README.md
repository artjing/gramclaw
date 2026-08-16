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
| Direct sign-in | Type a username and password locally; the password is discarded and the reusable session stays in the operating-system credential store |
| Automation-ready CLI | The same local memory exposed through a JSON-first CLI, backups, caching, and guarded publishing |

## How to use it

Node.js 22.13 or newer is required. The installable app lives in `gramclaw/`.

```bash
git clone https://github.com/artjing/gramclaw.git
cd gramclaw/gramclaw
npm install
npm link
gramclaw init
gramclaw serve --open
```

The app opens at [http://127.0.0.1:4667](http://127.0.0.1:4667).

1. In Instagram / Meta Accounts Center, download your information (JSON or HTML ZIP).
2. In the app, tap **Import archive ZIP** and choose the file.
3. Optional: tap **Enable update sync** to sign in, then **Append 30 recent posts** when you want recent updates.

To reopen later: `gramclaw serve --open`. For CLI details, see [`gramclaw/README.md`](gramclaw/README.md).

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
