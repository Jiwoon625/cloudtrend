import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { verifyDeployment } from "../scripts/verify-deployment-assets.mjs";

const commit = "release-123";
const js = `/assets/${commit}/app.js`;
const css = `/assets/${commit}/app.css`;
const contents = { [js]: "console.log('ready')", [css]: "body{color:black}" };
const manifest = {
  commit,
  assets: Object.entries(contents).map(([path, value]) => ({
    path,
    sha256: createHash("sha256").update(value).digest("hex"),
  })),
};
async function fixture(mode, run) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/deployment-manifest.json") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(manifest));
    } else if (path === "/" || path === "/scoring") {
      res.setHeader("content-type", "text/html");
      res.setHeader("cache-control", "private, no-store");
      res.setHeader("x-cloudtrend-code-version", mode === "stale" ? "old-release" : commit);
      res.end(`<link rel="stylesheet" href="${css}"><script src="${js}"></script>`);
    } else {
      res.setHeader("content-type", path.endsWith(".css") ? "text/css" : "application/javascript");
      if (mode === "404" && path === js) res.statusCode = 404;
      res.end(mode === "corrupt" && path === js ? "wrong file" : contents[path]);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
test("accepts matching HTML, release paths and exact asset contents", () =>
  fixture("ok", async (base) => {
    assert.equal((await verifyDeployment(base, commit)).verifiedAssets, 2);
  }));
test("rejects a stale HTML deployment", () =>
  fixture("stale", async (base) => {
    await assert.rejects(verifyDeployment(base, commit), /HTML is from another deployment/);
  }));
test("rejects missing startup JavaScript even if the page itself returns 200", () =>
  fixture("404", async (base) => {
    await assert.rejects(verifyDeployment(base, commit), /HTTP 404/);
  }));
test("rejects wrong asset bytes even if the asset returns 200", () =>
  fixture("corrupt", async (base) => {
    await assert.rejects(verifyDeployment(base, commit), /content mismatch/);
  }));
