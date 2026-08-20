# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- The installable CLI/local app lives in `gramclaw/`; run its complete auth,
  core, lock, and Python sidecar suite with `cd gramclaw && npm test`.
- Direct Instagram authentication is intentionally a credential source, not a
  data transport. The authoritative boundaries are
  `gramclaw/python/gramclaw_instagram.py`,
  `gramclaw/src/instagram-auth.js`, the adapter in `gramclaw/src/live.js`,
  and the macOS WKWebView helper `gramclaw/native/macos-login.swift`
  (launched from `gramclaw/src/webview-login.js`; tests must mock it).
- Never add a password argument/environment variable or plaintext session
  fallback. Sessions remain in the OS keyring, while `config.json` contains
  only safe `auth.instagram` metadata.
- Manual release gates, never in CI: instagrapi cookies and WKWebView-helper
  cookies must both work with `webWhoAmI()`. If the login window succeeds but
  Instagram rejects cookie replay, stop iterating browser-cookie work and send
  Instagram requests through the same WebView session.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
