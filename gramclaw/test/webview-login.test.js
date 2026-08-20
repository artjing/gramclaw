import assert from "node:assert/strict";
import test from "node:test";
import {
  filterWebviewCookies,
  parseWebviewLoginOutput,
  readWebviewLoginCookies,
} from "../src/webview-login.js";

test("webview login cookies keep only Instagram allowlisted names", () => {
  const cookies = filterWebviewCookies([
    { name: "sessionid", value: "sid-canary", domain: ".instagram.com" },
    { name: "csrftoken", value: "csrf-canary", domain: "www.instagram.com" },
    { name: "sessionid", value: "other-canary", domain: ".example.com" },
    { name: "secret", value: "nope", domain: ".instagram.com" },
    { name: "ds_user_id", value: "", domain: ".instagram.com" },
  ]);
  assert.deepEqual(cookies.map((cookie) => cookie.name).sort(), ["csrftoken", "sessionid"]);
  assert.equal(cookies.every((cookie) => cookie.domain.includes("instagram.com")), true);
  assert.equal(cookies.every((cookie) => cookie.source.browser === "webview"), true);
});

test("webview login parser reads the last helper JSON line and drops unsigned-in windows", async () => {
  const parsed = parseWebviewLoginOutput("ok\n{\"ok\":true,\"cookies\":[{\"name\":\"sessionid\",\"value\":\"sid-canary\",\"domain\":\".instagram.com\"},{\"name\":\"csrftoken\",\"value\":\"csrf-canary\",\"domain\":\".instagram.com\"},{\"name\":\"secret\",\"value\":\"nope\",\"domain\":\".instagram.com\"}],\"cancelled\":false}\n");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.cookies.length, 3);

  const signedIn = await readWebviewLoginCookies({
    runHelper: async () => ({
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        cancelled: false,
        cookies: [
          { name: "sessionid", value: "sid-canary", domain: ".instagram.com" },
          { name: "csrftoken", value: "csrf-canary", domain: ".instagram.com" },
          { name: "secret", value: "nope", domain: ".instagram.com" },
        ],
      }),
    }),
  });
  assert.deepEqual(signedIn.cookies.map((cookie) => cookie.name).sort(), ["csrftoken", "sessionid"]);
  assert.equal(signedIn.warnings.length, 0);
  assert.doesNotMatch(JSON.stringify(signedIn.warnings), /sid-canary|csrf-canary|nope/);

  const missing = await readWebviewLoginCookies({
    runHelper: async () => ({
      code: 3,
      stdout: JSON.stringify({ ok: false, cookies: [], cancelled: false, error: "not_signed_in" }),
    }),
  });
  assert.equal(missing.cookies.length, 0);
  assert.match(missing.warnings[0], /Gramclaw login window/);
  assert.doesNotMatch(missing.warnings[0], /sessionid|csrftoken|canary/);
});
