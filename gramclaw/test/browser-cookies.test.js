import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { readChromiumInstagramCookies } from "../src/browser-cookies.js";

test("chromium cookie fallback reads plaintext Instagram cookies without logging secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "gramclaw-cookie-test-"));
  const dbPath = join(dir, "Cookies");
  try {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE cookies (
        name TEXT,
        value TEXT,
        host_key TEXT,
        encrypted_value BLOB
      );
    `);
    db.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?)").run("sessionid", "session-canary", ".instagram.com", Buffer.alloc(0));
    db.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?)").run("csrftoken", "csrf-canary", ".instagram.com", Buffer.alloc(0));
    db.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?)").run("unrelated", "nope", ".example.com", Buffer.alloc(0));
    db.close();

    const result = readChromiumInstagramCookies({ dbPath });
    assert.equal(result.cookies.length, 2);
    assert.deepEqual(result.cookies.map((cookie) => cookie.name).sort(), ["csrftoken", "sessionid"]);
    assert.equal(result.cookies.find((cookie) => cookie.name === "sessionid").value, "session-canary");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
