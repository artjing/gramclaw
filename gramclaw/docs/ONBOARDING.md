# Welcome to Gramclaw

Gramclaw keeps your Instagram memory on **your computer**.

Start with your official Meta download. Signing in is optional, and only for small updates later.

---

## Before you begin

You need:

- A Mac (or computer) with **Node.js 22.13+**
- Your Instagram data export ZIP from Meta (HTML or JSON both work)

That’s enough for the main experience.

---

## Step 1 — Install and open Gramclaw

```bash
npm install -g ./gramclaw-1.1.0.tgz
gramclaw init
gramclaw serve --open
```

The app opens at [http://127.0.0.1:4667](http://127.0.0.1:4667).

---

## Step 2 — Download your Instagram data from Meta

1. Open **Instagram / Meta Accounts Center**
2. Go to **Your information** → **Download your information**
3. Request a copy of your data
4. Wait for Meta’s email or notification
5. Download the ZIP to your computer (usually Downloads)

Tip: JSON or HTML format are both fine.

---

## Step 3 — Import the ZIP into Gramclaw

In the app:

1. Tap **Import archive ZIP**
2. Choose your export from the list, or paste the file path
3. Wait for import to finish
4. Tap **Open workspace**

Your posts, saved items, likes, messages, and more are now searchable locally.

Imports are safe to run again later — new data merges in; it won’t wipe your library.

---

## Step 4 — (Optional) Turn on update sync

Only do this if you want Gramclaw to fetch **recent updates** after the archive.

Then:

1. In the app, choose **Enable update sync**
2. Tap **Open Instagram** — a Gramclaw login window opens
3. Sign in on Instagram’s official page (including any 2FA). Gramclaw connects when that window finishes.
4. If it does not connect automatically, return here and tap **I’ve signed in — continue**
5. Tap **Append 30 recent posts** when you want small updates

This uses Gramclaw’s own login window, not everyday Chrome or Safari cookies. Sync is for recent changes — not as a replacement for the full Meta ZIP.

---

## Everyday use

| You want to… | Do this |
|--------------|---------|
| Open your library | `gramclaw serve --open` |
| Add a newer Meta export | Import archive again |
| Pull a few recent posts | Enable update sync, then Sync |
| Sign out of Gramclaw only | `gramclaw logout` |

---

## Privacy, in plain words

- Your ZIP is processed on your machine
- Your Instagram password is never saved
- If you enable sync, the session stays in your system keychain
- Your library lives under `~/.gramclaw/`

Gramclaw does not upload your archive to a cloud server.

---

## Quick troubleshooting

**Import says it failed**  
Make sure you selected an Instagram/Meta export ZIP (or the extracted folder). Try **Refresh list** after the download finishes.

**I don’t see the import screen**  
Your library may already have data. Use the account button → **Import archive ZIP**.

**Sync asks for a code**  
Finish the code or approval in the Gramclaw login window (Instagram’s official page). If Gramclaw still cannot connect after that window shows you as signed in, Instagram rejected the reused session — use archive import instead.

**I’d rather skip sync**  
That’s fine. Archive import alone is the recommended path.

---

## Need a command-line version?

```bash
gramclaw import archive ~/Downloads/your-instagram-export.zip
gramclaw serve --open

# optional later:
gramclaw login
gramclaw sync posts --limit 30
```

---

Enjoy your local Instagram memory.
