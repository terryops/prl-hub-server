import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { makeEnv } from "./helpers.js";

// prl.tools.video's pages move to pearlhub.net; its /v1 API and the other domains' pages do not.
// PRL_DOMAIN_WORKER runs the same checks against the frozen production bundle before a release.
const { default: worker } = await import(process.env.PRL_DOMAIN_WORKER
  ? pathToFileURL(process.env.PRL_DOMAIN_WORKER).href : "../src/index.js");

function env() {
  const served = [];
  const e = makeEnv({ ASSETS: { fetch: async (req) => { served.push(new URL(req.url).href); return new Response("<!doctype html>page", { headers: { "content-type": "text/html" } }); } } });
  return { e, served };
}
const get = (e, url, init) => worker.fetch(new Request(url, init), e, { waitUntil() {} });

test("old domain pages: 301 to the same path and query on pearlhub.net, cached an hour", async () => {
  const { e, served } = env();
  for (const [path, to] of [["/", "https://pearlhub.net/"], ["/?account=manage", "https://pearlhub.net/?account=manage"],
    ["/?account=restore&client=apple", "https://pearlhub.net/?account=restore&client=apple"],
    ["/index.html", "https://pearlhub.net/index.html"], ["/privacy.html", "https://pearlhub.net/privacy.html"],
    ["/privacy", "https://pearlhub.net/privacy"], ["/support", "https://pearlhub.net/support"]]) {
    const res = await get(e, "https://prl.tools.video" + path);
    assert.equal(res.status, 301, path);
    assert.equal(res.headers.get("location"), to, path);
    assert.equal(res.headers.get("cache-control"), "public, max-age=3600", path);
    assert.equal(await res.text(), "", path);
  }
  const head = await get(e, "https://prl.tools.video/", { method: "HEAD" });
  assert.equal(head.status, 301);
  assert.deepEqual(served, [], "the old domain's pages never reach the assets");
});

test("pearlhub.net and www pages are served from the assets as before", async () => {
  const { e, served } = env();
  for (const url of ["https://pearlhub.net/", "https://www.pearlhub.net/?account=manage", "https://pearlhub.net/privacy.html"]) {
    const res = await get(e, url);
    assert.equal(res.status, 200, url);
    assert.equal(await res.text(), "<!doctype html>page", url);
  }
  assert.deepEqual(served, ["https://pearlhub.net/", "https://www.pearlhub.net/?account=manage", "https://pearlhub.net/privacy.html"]);
});

test("the old domain's /v1 API still answers (apps before 2.0, App Store notifications)", async () => {
  const { e, served } = env();
  for (const path of ["/v1/web/status", "/v1/nope"]) {
    const res = await get(e, "https://prl.tools.video" + path);
    assert.notEqual(res.status, 301, path);
    assert.equal(res.headers.get("location"), null, path);
    assert.match(res.headers.get("content-type") || "", /json/, path);
  }
  const status = await get(e, "https://prl.tools.video/v1/web/status");
  assert.equal(status.status, 200);
  assert.ok("pay" in await status.json());
  const asn = await get(e, "https://prl.tools.video/v1/asn/wrong-secret", { method: "POST", body: "{}" });
  assert.notEqual(asn.status, 301);
  assert.deepEqual(served, []);
});
