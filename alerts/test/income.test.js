import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { legs, external } from "../src/income.js";
import { makeEnv, call, setNow, restoreNow, T0 } from "./helpers.js";
const original = fetch;
afterEach(() => { globalThis.fetch = original; restoreNow(); delete globalThis.caches; });
const addr = "prl1" + "a".repeat(38), other = "prl1" + "b".repeat(38);
const leg = (time, received, sent = "0", sentToSelf = "0") => ({ time, received, sent, sentToSelf });
test("income: Swift gross legs, transfer tolerance and lifetime semantics", async () => {
  assert.deepEqual(legs([leg(1, "100", "250", "100")]), [{ t: 1, recv: 0, sent: 150 }]);
  assert.equal(external(legs([leg(1, "100000000"), leg(2, "300000000")]), [legs([leg(1, "0", "102000000")])]), 3);
  assert.equal(external(legs([leg(1, "100000000")]), [legs([leg(1, "0", "102000001")])]), 1);
  setNow(T0); const env = makeEnv();
  const requests = [];
  globalThis.fetch = async (u) => {
    requests.push(String(u));
    const url = new URL(u);
    return Response.json(url.searchParams.get("groupBy") === "86400" ? [leg(T0, "900000000", "600000000", "500000000")] : url.pathname.endsWith(other) ? [leg(T0 - 1, "100000000", "300000000", "100000000")] : [leg(T0 - 1, "200000000"), leg(T0 - 2, "500000000"), leg(T0 - 90000, "100000000")]);
  };
  const r = await call(env, "POST", "/v1/address/income", { addr, own: [addr, other] });
  assert.equal(r.status, 200); assert.equal(r.body.h24, 5); assert.equal(r.body.d7, 6); assert.equal(r.body.total, 4);
  assert.equal(requests.length, 3); assert.ok(requests.some((r) => r.includes("groupBy=86400")));
  assert.equal(Number(env.DB.one("SELECT v FROM kv WHERE k LIKE 'pb:Blockbook:%'").v), 3);
});
test("income: invalid own list, upstream failures and read/budget throttles never become zero", async () => {
  globalThis.fetch = async () => Response.json({ error: "unavailable" });
  const e = makeEnv();
  assert.equal((await call(e, "POST", "/v1/address/income", { addr })).status, 502);
  for (const own of [["bad"], Array(21).fill(addr), "bad"]) assert.equal((await call(e, "POST", "/v1/address/income", { addr, own })).status, 400);
  assert.equal((await call(makeEnv({ RL_READ: { limit: async () => ({ success: false }) } }), "POST", "/v1/address/income", { addr })).status, 429);
});
test("income: recent/lifetime caches have independent TTLs, deduplicate and hash addresses", async () => {
  setNow(T0); const e = makeEnv(), entries = new Map(), ttls = [];
  globalThis.caches = { default: { match: async (r) => entries.get(r.url)?.clone(), put: async (r, v) => { assert.ok(!r.url.includes(addr)); ttls.push(v.headers.get("cache-control")); entries.set(r.url, v.clone()); } } };
  let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json([leg(T0, "100000000")]); };
  await Promise.all([call(e, "POST", "/v1/address/income", { addr }), call(e, "POST", "/v1/address/income", { addr })]);
  await call(e, "POST", "/v1/address/income", { addr });
  assert.equal(requests, 2); assert.deepEqual(ttls.sort(), ["public, max-age=60", "public, max-age=600"]);
});
test("income: concurrent requests sharing cold addresses never read each other's Response", async () => {
  // Model the Workers rule in Node: a Response may only be read by the request that created it.
  // Before the fix the second request cloned the first one's Response and got 502.
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const als = new AsyncLocalStorage(), owner = new WeakMap(), Base = globalThis.Response, proto = Base.prototype, saved = {};
  for (const m of ["text", "json", "arrayBuffer", "clone"]) {
    saved[m] = proto[m];
    proto[m] = function (...args) {
      const o = owner.get(this);
      if (o !== undefined && o !== als.getStore()) throw new Error("Cannot perform I/O on behalf of a different request");
      const r = saved[m].apply(this, args);
      if (m === "clone") owner.set(r, o);
      return r;
    };
  }
  globalThis.Response = class extends Base {
    constructor(...args) { super(...args); owner.set(this, als.getStore()); }
    static json(...args) { const r = Base.json(...args); owner.set(r, als.getStore()); return r; }
  };
  try {
    setNow(T0); const e = makeEnv(), own = [addr, other];
    let requests = 0;
    globalThis.fetch = async () => { requests++; await new Promise((r) => setTimeout(r, 20)); return Response.json([leg(T0 - 1, "100000000")]); };
    const replies = await Promise.all(own.map((a, i) => als.run(i + 1, () => call(e, "POST", "/v1/address/income", { addr: a, own }))));
    assert.deepEqual(replies.map((r) => r.status), [200, 200]);
    assert.deepEqual(replies.map((r) => r.body.d7), [1, 1]);
    assert.equal(requests, 4); // both recent histories are shared; each request adds its own lifetime total
  } finally { globalThis.Response = Base; Object.assign(proto, saved); }
});
