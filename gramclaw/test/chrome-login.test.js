import assert from "node:assert/strict";
import test from "node:test";
import { readChromeLoginCookies } from "../src/chrome-login.js";

test("chrome login cookies keep only Instagram allowlisted names from CDP", async () => {
  const result = await readChromeLoginCookies({
    fetchJson: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9229/devtools" }),
    openSocket() {
      const listeners = new Map();
      queueMicrotask(() => listeners.get("open")?.());
      return {
        addEventListener(type, fn) {
          listeners.set(type, fn);
        },
        send() {
          listeners.get("message")?.({
            data: JSON.stringify({
              id: 1,
              result: {
                cookies: [
                  { name: "sessionid", value: "sid-canary", domain: ".instagram.com" },
                  { name: "csrftoken", value: "csrf-canary", domain: "www.instagram.com" },
                  { name: "sessionid", value: "other-canary", domain: ".example.com" },
                  { name: "secret", value: "nope", domain: ".instagram.com" },
                ],
              },
            }),
          });
        },
        close() {},
      };
    },
  });
  assert.deepEqual(result.cookies.map((cookie) => cookie.name).sort(), ["csrftoken", "sessionid"]);
  assert.equal(result.cookies.every((cookie) => cookie.domain.includes("instagram.com")), true);
  assert.equal(result.warnings.length, 0);
});

test("chrome login cookies warn when the debug window is not running", async () => {
  const result = await readChromeLoginCookies({
    fetchJson: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(result.cookies.length, 0);
  assert.match(result.warnings[0], /Gramclaw Chrome login window is not running/);
});
