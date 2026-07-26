# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- The installable CLI/local app lives in `gramclaw/`; run its complete auth,
  core, lock, and Python sidecar suite with `cd gramclaw && npm test`.
- Direct Instagram authentication is intentionally a credential source, not a
  data transport. The authoritative boundaries are
  `gramclaw/python/gramclaw_instagram.py`,
  `gramclaw/src/instagram-auth.js`, and the adapter in
  `gramclaw/src/live.js`.
- Never add a password argument/environment variable or plaintext session
  fallback. Sessions remain in the OS keyring, while `config.json` contains
  only safe `auth.instagram` metadata.
- A controlled-account check that instagrapi cookies work with the existing
  `webWhoAmI()` web transport is a manual release gate; automated tests must
  never perform a real Instagram login.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
