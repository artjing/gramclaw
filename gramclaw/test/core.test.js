import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importArchive } from "../src/archive.js";
import { setHomeOverride } from "../src/config.js";
import { closeDb, getDb, seedDemoData } from "../src/db.js";
import { getStatus, graphQuery, listPosts, searchDms } from "../src/queries.js";
import { serve } from "../src/server.js";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "gramclaw-test-"));
  setHomeOverride(join(root, "home"));
  closeDb();
  return {
    root,
    cleanup() {
      closeDb();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("demo seed creates a searchable local workspace", () => {
  const scope = workspace();
  try {
    const db = getDb();
    const seeded = seedDemoData(db);
    assert.equal(seeded.seeded, true);
    const status = getStatus(db);
    assert.equal(status.counts.posts, 8);
    assert.equal(status.counts.dmThreads, 3);
    const search = listPosts(db, { query: "studio" });
    assert.ok(search.items.length >= 1);
    const dms = searchDms(db, "layout");
    assert.equal(dms.length, 1);
    const graph = graphQuery(db, "summary");
    assert.equal(graph.followers, 7);
    assert.equal(graph.mutuals, 6);
  } finally {
    scope.cleanup();
  }
});

test("Instagram JSON export imports posts, saves, follows, and DMs idempotently", async () => {
  const scope = workspace();
  try {
    const archive = join(scope.root, "instagram-export");
    const paths = [
      "personal_information/personal_information",
      "media",
      "your_instagram_activity/likes",
      "your_instagram_activity/saved",
      "connections/followers_and_following",
      "messages/inbox/nora_123",
    ];
    for (const path of paths) mkdirSync(join(archive, path), { recursive: true });
    writeJson(join(archive, "personal_information/personal_information/personal_information.json"), {
      profile_user: [{
        string_map_data: {
          Username: { value: "marea.studio" },
          Name: { value: "Marea Studio" },
          Bio: { value: "Material studies" },
        },
      }],
    });
    writeJson(join(archive, "media/posts_1.json"), [{
      title: "A material study from the north wall.",
      creation_timestamp: 1_700_000_000,
      media: [{ uri: "media/posts/sample.jpg", creation_timestamp: 1_700_000_000 }],
    }]);
    writeJson(join(archive, "your_instagram_activity/likes/liked_posts.json"), {
      likes_media_likes: [{
        title: "nora.works",
        string_list_data: [{ href: "https://www.instagram.com/p/ABC123/", timestamp: 1_700_000_100 }],
      }],
    });
    writeJson(join(archive, "your_instagram_activity/saved/saved_posts.json"), {
      saved_saved_media: [{
        title: "linh.makes",
        string_map_data: { "Saved on": { href: "https://www.instagram.com/p/DEF456/", timestamp: 1_700_000_200 } },
      }],
    });
    writeJson(join(archive, "connections/followers_and_following/followers_1.json"), [{
      title: "",
      string_list_data: [{ href: "https://www.instagram.com/nora.works/", value: "nora.works", timestamp: 1_700_000_000 }],
    }]);
    writeJson(join(archive, "connections/followers_and_following/following.json"), {
      relationships_following: [{
        title: "nora.works",
        string_list_data: [{ href: "https://www.instagram.com/nora.works/", value: "nora.works", timestamp: 1_700_000_000 }],
      }],
    });
    writeJson(join(archive, "messages/inbox/nora_123/message_1.json"), {
      participants: [{ name: "Marea Studio" }, { name: "Nora Works" }],
      messages: [{
        sender_name: "Nora Works",
        timestamp_ms: 1_700_000_300_000,
        content: "The layout is ready for review.",
      }],
      title: "Nora Works",
      thread_path: "messages/inbox/nora_123",
    });

    const first = await importArchive(archive);
    assert.equal(first.counts.posts, 1);
    assert.equal(first.counts.likes, 1);
    assert.equal(first.counts.saved, 1);
    assert.equal(first.counts.directMessages, 1);
    const second = await importArchive(archive);
    assert.equal(second.ok, true);
    const status = getStatus(getDb());
    assert.equal(status.counts.posts, 3);
    assert.equal(status.counts.saved, 1);
    assert.equal(status.counts.liked, 1);
    assert.equal(status.counts.dmMessages, 1);
    assert.equal(graphQuery(getDb(), "summary").mutuals, 1);
  } finally {
    scope.cleanup();
  }
});

test("local web server exposes the seeded workspace", async () => {
  const scope = workspace();
  let server;
  try {
    seedDemoData(getDb());
    const running = await serve({ port: 0, host: "127.0.0.1" });
    server = running.server;
    const response = await fetch(`${running.url}/api/status`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.counts.posts, 8);
    const html = await (await fetch(running.url)).text();
    assert.match(html, /gramclaw/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    scope.cleanup();
  }
});

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
