import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "pages-dist");
const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("pages-build", String(Date.now()));
const { default: worker } = await import(workerUrl.href);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(resolve(root, "dist/client"), output, { recursive: true });

const routes = ["/", "/memory", "/social-memory"];
for (const route of routes) {
  const response = await worker.fetch(
    new Request(new URL(route, "https://gramclaw.website"), {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );

  if (!response.ok) {
    throw new Error(`Failed to render ${route}: ${response.status}`);
  }

  const directory = route === "/" ? output : resolve(output, route.slice(1));
  await mkdir(directory, { recursive: true });
  const html = (await response.text()).replaceAll(
    "https://gramclaw.local",
    "https://gramclaw.website",
  );
  await writeFile(resolve(directory, "index.html"), html);
}

await writeFile(resolve(output, "CNAME"), "gramclaw.website\n");
await writeFile(resolve(output, ".nojekyll"), "");
