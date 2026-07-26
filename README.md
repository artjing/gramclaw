# Gramclaw

Gramclaw is a fully local-first Instagram workspace inspired by Birdclaw. It
imports Instagram JSON exports into SQLite, preserves posts and media, indexes
captions, comments, and DMs with FTS5, tracks relationship changes, and exposes
the same normalized memory through a local web app and JSON-first CLI.

The root project is the public product and download site. The installable
application lives in `gramclaw/`.

## Release

Node.js 22.13 or newer is required.

```bash
npm install -g ./gramclaw-1.1.0.tgz
gramclaw init --demo
gramclaw serve --open
```

For a real archive:

```bash
gramclaw import archive ~/Downloads/instagram-export.zip --json
gramclaw serve --open
```

See `gramclaw/README.md` for archive import, live adapters, guarded publishing,
private media analysis, visual search, smart Saved collections, boards, media
caching, backup, and complete CLI documentation.

## Public site

```bash
npm install
npm run dev
npm test
npm run lint
```

The site is built with vinext for OpenAI Sites. It ships the npm tarball and
source bundle from `public/downloads/`.
