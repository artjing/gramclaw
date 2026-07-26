# Gramclaw

Gramclaw is a local-first Instagram workspace: data-export import, cached live reads, full-text search, relationship history, DM triage, media preservation, Git-friendly backups, scriptable JSON, and a local web app.

It is inspired by the local-first architecture of Birdclaw, translated to Instagram’s native objects: posts, carousels, reels, stories, comments, saves, likes, followers/following, and direct messages.

## Install

Node.js 22.13 or newer is required.

```bash
npm install -g ./gramclaw-1.0.0.tgz
gramclaw init --demo
gramclaw serve --open
```

From source:

```bash
npm install
npm link
gramclaw init --demo
```

## Bring your Instagram history

Instagram lets you export selected information from Accounts Center. Choose JSON and include the categories you want Gramclaw to index.

```bash
gramclaw archive find --json
gramclaw import archive ~/Downloads/instagram-export.zip --json
gramclaw import archive ~/Downloads/instagram-export.zip \
  --select posts,stories,comments,saved,likes,directMessages,followers,following
```

Imports are idempotent and merge-safe by default. Add `--restore` only when the selected archive slices should exactly replace prior archive rows.

## Local web workspace

```bash
gramclaw serve --open
```

The server listens on `127.0.0.1:4667` by default. It includes:

- Home feed for cached posts, reels, carousels, and stories
- Saved and liked review lanes
- Full-text search across captions, comments, and DMs
- Priority inbox combining comments and DMs
- DM conversation reader
- Followers, following, mutuals, non-mutuals, and relationship events
- Local posting insights
- Draft queue and guarded live actions

Set `GRAMCLAW_WEB_TOKEN` to add an application token. Remote binding is refused unless `GRAMCLAW_ALLOW_REMOTE_WEB=1`.

## Live reads with your existing browser session

Gramclaw can read Instagram’s web endpoints with cookies from a supported signed-in browser. It uses `@steipete/sweet-cookie` and never copies raw cookie values into SQLite, JSON output, or backups.

```bash
gramclaw auth status --json
gramclaw auth whoami --cookie-source safari --json
gramclaw sync posts --mode cookie --limit 100 --json
gramclaw sync saved --mode cookie --limit 100 --json
gramclaw sync dms --mode cookie --limit 30 --json
gramclaw sync followers --mode cookie --limit 500 --json
```

Explicit environment variables are also supported:

```bash
export GRAMCLAW_SESSIONID="..."
export GRAMCLAW_CSRFTOKEN="..."
export GRAMCLAW_DS_USER_ID="..."
```

Instagram’s private web endpoints can change without notice and may rate-limit automation. Archive-only mode remains fully usable when live transport breaks.

## Official Instagram Graph transport

Professional accounts can use the official Instagram Graph API for own-media sync and content publishing.

```bash
export GRAMCLAW_ACCESS_TOKEN="..."
export GRAMCLAW_IG_USER_ID="..."
export GRAMCLAW_GRAPH_VERSION="v24.0" # override when your Meta app uses another version

gramclaw sync posts --mode graph --json
gramclaw compose post "Field notes." \
  --transport graph \
  --media https://cdn.example.com/photo.jpg \
  --yes --json
gramclaw compose post "A new reel." \
  --transport graph --reel \
  --media https://cdn.example.com/reel.mp4 \
  --yes --json
```

Graph publishing requires media at a public URL. Carousel, reel, story, comment, reply, and messaging commands are included.

## Safe writes

Live actions are drafts unless you pass `--yes`. The local web app also stays draft-only unless `GRAMCLAW_ENABLE_LIVE_WRITES=1`.

```bash
gramclaw like <post-id>                 # local draft
gramclaw like <post-id> --yes           # live cookie write
gramclaw compose comment <post-id> Nice work
gramclaw compose dm <thread-id> "Sending this now." --yes
gramclaw compose post "Studio shelf." --media shelf.jpg --yes
gramclaw actions list --status draft --json
```

Cookie publishing currently accepts one local JPEG for a feed post or story. Use the Graph transport for carousels, reels, videos, and URL-based publishing.

## Agent-ready CLI

Every read command supports `--json`.

```bash
gramclaw search posts "material study" --saved --json
gramclaw search dms "project quote" --json
gramclaw posts read <id-or-shortcode> --json
gramclaw inbox --limit 20 --json
gramclaw graph summary --json
gramclaw graph mutuals --limit 50 --json
gramclaw graph non-mutual-following --json
gramclaw graph events --since 2026-01-01 --json
gramclaw profiles show @username --json
gramclaw insights --json
```

## Media cache

Imported archive media is copied into `~/.gramclaw/media/originals/archive`. Live media can be fetched later on a separate, paced schedule:

```bash
gramclaw media fetch --limit 200 --concurrency 3 --delay-ms 250 --json
```

## Git-friendly backup

SQLite remains the canonical local truth. Backups are deterministic JSONL, excluding cookies, tokens, WAL files, FTS shadow tables, and downloaded media.

```bash
gramclaw backup export ~/Backups/gramclaw
gramclaw backup validate ~/Backups/gramclaw
gramclaw backup import ~/Backups/gramclaw
gramclaw backup sync \
  --repo ~/Projects/gramclaw-private \
  --remote git@github.com:you/gramclaw-private.git
```

## Storage

```text
~/.gramclaw/
  gramclaw.sqlite
  config.json
  media/
    originals/archive/
    originals/live/
    thumbs/
  backups/
  audit/
  logs/
```

Override the root per invocation with `--home <path>` or globally with `GRAMCLAW_HOME`.

## Important

Gramclaw is an independent tool and is not affiliated with Instagram or Meta. Archive import and the official Graph transport are the durable paths. Cookie transport uses undocumented web endpoints and should be used gently, on accounts you control, in accordance with applicable platform terms and law.
