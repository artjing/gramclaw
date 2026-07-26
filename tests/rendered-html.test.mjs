import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the complete Gramclaw product site", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Gramclaw — Your Instagram history, actually yours<\/title>/i);
  assert.match(html, /Your Instagram history\./);
  assert.match(html, /Actually yours\./);
  assert.match(html, /127\.0\.0\.1:4667/);
  assert.match(html, /A working memory, not a dashboard/);
  assert.match(html, /Private by architecture/);
  assert.match(html, /downloads\/gramclaw-1\.1\.0\.tgz/);
  assert.match(html, /downloads\/gramclaw-source\.zip/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton/);
});

test("ships metadata and installable release artifacts", async () => {
  const [layout, packageFile, sourceFile, socialCard, favicon] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    access(new URL("../public/downloads/gramclaw-1.1.0.tgz", import.meta.url)),
    access(new URL("../public/downloads/gramclaw-source.zip", import.meta.url)),
    access(new URL("../public/og.png", import.meta.url)),
    access(new URL("../public/favicon.png", import.meta.url)),
  ]);

  assert.match(layout, /summary_large_image/);
  assert.match(layout, /\/og\.png/);
  assert.match(layout, /\/favicon\.png/);
  assert.equal(packageFile, undefined);
  assert.equal(sourceFile, undefined);
  assert.equal(socialCard, undefined);
  assert.equal(favicon, undefined);
});
