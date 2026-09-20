# Gramclaw

Your private, searchable Instagram memory. Import your Instagram archive, find old posts and conversations, organize Saved ideas, and build visual boards—all on your own computer.

**Website:** [gramclaw.website](https://gramclaw.website)

## Install

Requires Node.js 22.13 or newer.

```bash
git clone https://github.com/artjing/gramclaw.git
cd gramclaw/gramclaw
npm install
npm link
gramclaw init
gramclaw serve --open
```

Gramclaw opens at [http://127.0.0.1:4667](http://127.0.0.1:4667).

## Use it

1. Download your information from Instagram / Meta Accounts Center as a JSON or HTML ZIP.
2. In Gramclaw, choose **Import archive ZIP**.
3. Search, browse Saved items, and organize references into boards.

Update sync is optional. Choose **Enable update sync** to append a small number of recent posts after importing your archive. On macOS, the Instagram window can take up to a minute to open the first time.

Try fictional sample data without connecting Instagram:

```bash
gramclaw init --demo
gramclaw serve --open
```

## What stays local

Your archive, database, media, messages, cookies, and tokens are not uploaded to the Gramclaw website. The local app listens on `127.0.0.1` by default.

For CLI commands and technical details, see [gramclaw/README.md](gramclaw/README.md).

MIT licensed.
