// 掉线提醒: pool parsing (against the app's own fixtures, so the worker and the app
// read each pool the same way), the outage state machine, and the whole path
// PUT watches → cron poll → APNs.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as H from "./helpers.js";
import { installFetch, setNow, restoreNow, T0, tok, call, register, tick, makeChain, signJWS, proTx } from "./helpers.js";
import { parseMiner, sanitizeTarget, POOLS, MAX_WORKERS, ANON } from "../src/pools.js";
import { fold, due, tell, unpack, sanitizeWatch, COOLDOWN, STEADY, RECHECK, AFTER, AGAIN } from "../src/watch.js";
import { offlinePayloadFor, onlinePayloadFor, stillPayloadFor, fmtAgo, LANGS } from "../src/i18n.js";

afterEach(restoreNow);

// Watches are only taken with a signed Pro purchase: every environment here trusts
// one test chain, and `watch` sends a purchase signed by it unless told otherwise.
const chain = await makeChain();
const PRO = await signJWS(chain, proTx());
const makeEnv = (extra = {}, hooks = {}) => H.makeEnv({ APPLE_ROOT_SHA256: chain.rootSHA256, ...extra }, hooks);
const watch = (env, token, watches, extra = {}) => H.watch(env, token, watches, { pro_jws: PRO, ...extra });

const fixtures = fileURLToPath(new URL("../../Tests/Fixtures/", import.meta.url));
const fx = (name) => readFileSync(fixtures + name, "utf8");
const names = (r) => r.workers.map((w) => w.name);
const plain = (o) => JSON.parse(JSON.stringify(o));

// ── pools ────────────────────────────────────────────────────────────────────

test("pools: the eight pools the app monitors, by the app's names", () => {
  assert.deepEqual([...POOLS].sort(), ["AlphaPool", "F2Pool", "HeroMiners", "Jetski", "Kryptex", "Lucky Pool", "Pearl Fortune", "PearlHash"]);
});

test("pools: Jetski — the name after the address, online for 10 min after the last share; zeros are missing", () => {
  const r = parseMiner("Jetski", 200, fx("jetski_miner.json"), 1792283530);
  assert.deepEqual(r.workers.map((w) => [w.name, w.online, w.last]), [
    ["AP201", true, 1792283526], ["C4000F", true, 1792283473], ["NZXTH3", true, 1792283473], ["P3630", false, 1792281619],
  ]);
  assert.deepEqual(parseMiner("Jetski", 200, fx("jetski_miner.json"), 1792284200).workers.map((w) => w.online), [false, false, false, false]);
  assert.deepEqual(parseMiner("Jetski", 200, fx("jetski_miner_empty.json"), 0), { missing: true });
  assert.throws(() => parseMiner("Jetski", 400, "", 0), /http 400/);
  // Paid out, nothing connected: a known miner with no workers, not a stranger.
  assert.deepEqual(parseMiner("Jetski", 200, '{"total_paid_grains":5,"workers":[]}', 0), { workers: [], partial: false });
  const odd = JSON.stringify({ workers: [{ worker: "prl1pabc", last_share_time: null }, { worker: "prl1pabc.a.b" }, { worker: "prl1pabc." }, {}] });
  assert.deepEqual(names(parseMiner("Jetski", 200, odd, 0)), ["prl1pabc", "a.b", "default"]);
});

test("pools: AlphaPool — the pool's own online flag, last share from `time`; a stranger is missing", () => {
  const r = parseMiner("AlphaPool", 200, fx("alphapool_miner_idle.json"), 1790475000);
  assert.deepEqual(r.workers, [{ name: "4070d", online: false, last: 1790472075 }]);
  assert.deepEqual(parseMiner("AlphaPool", 200, fx("alphapool_miner_empty.json"), 1790475000), { missing: true });
  // No flag: online for 10 min after the last share, like the app.
  const body = JSON.stringify({ last_seen: 5, workers: [{ name: "a", time: 1000 }, { name: "b", time: 400 }, { name: "c" }] });
  assert.deepEqual(parseMiner("AlphaPool", 200, body, 1500).workers.map((w) => w.online), [true, false, false]);
});

test("pools: F2Pool — status 0 is online (number or string), a short page is partial", () => {
  const r = parseMiner("F2Pool", 200, fx("f2pool_workers.json"), 1790475000);
  assert.deepEqual(r.workers, [
    { name: "rig-a", online: true, last: 1790475000 },
    { name: "rig-b", online: false, last: 1790400000 },
    { name: "—", online: false, last: null },
  ]);
  assert.equal(r.partial, false);
  const page = JSON.stringify({ originData: { workers: [{ name: "a", status: "0" }], worker_length_all: 40 } });
  assert.deepEqual(parseMiner("F2Pool", 200, page, 0), { workers: [{ name: "a", online: true, last: null }], partial: true });
  assert.deepEqual(parseMiner("F2Pool", 404, "<!doctype html>", 0), { missing: true });      // key revoked
  assert.throws(() => parseMiner("F2Pool", 200, "<!doctype html><html>", 0));                 // the HTML page, not JSON
});

test("pools: Kryptex — status string, last share in ms; no workers is an empty list, not missing", () => {
  assert.deepEqual(parseMiner("Kryptex", 200, fx("kryptex_workers.json"), 1790475100).workers,
                   [{ name: "worker", online: true, last: 1790475084 }]);
  assert.deepEqual(parseMiner("Kryptex", 200, fx("kryptex_workers_empty.json"), 0), { workers: [], partial: false });
  const both = JSON.stringify({ results: [{ worker: "r", scheme: "pps", status: "offline" }, { worker: "r", scheme: "solo", status: "ONLINE" }] });
  assert.deepEqual(parseMiner("Kryptex", 200, both, 0).workers.map((w) => [w.name, w.online]), [["r", false], ["r (SOLO)", true]]);
});

test("pools: HeroMiners and Lucky Pool — online for 10 min after the last share", () => {
  const hero = parseMiner("HeroMiners", 200, fx("herominers_miner.json"), 1790475100);
  assert.deepEqual(hero.workers.map((w) => [w.name, w.online, w.last]),
                   [["5-1-135", true, 1790474917], ["G2-102", true, 1790475050], ["G1-101", true, 1790475055]]);
  const later = parseMiner("HeroMiners", 200, fx("herominers_miner.json"), 1790475600);
  assert.deepEqual(later.workers.map((w) => w.online), [false, true, true]);
  assert.deepEqual(parseMiner("HeroMiners", 200, fx("herominers_miner_empty.json"), 0), { missing: true });

  const lucky = parseMiner("Lucky Pool", 200, fx("luckypool_miner.json"), 1790475100);
  assert.deepEqual(lucky.workers.map((w) => [w.name, w.online, w.last]),
                   [["RTX3070", true, 1790475079], ["RTX3070_8", true, 1790475080], ["3_solianka", true, 1790475059]]);
  assert.deepEqual(parseMiner("Lucky Pool", 404, '{"error":"Address not found"}', 0), { missing: true });
});

test("pools: Pearl Fortune — `stale` decides, last report from last_stats_at", () => {
  const r = parseMiner("Pearl Fortune", 200, fx("pearlfortune_connections.json"), 0);
  assert.deepEqual(r.workers, [
    { name: "0221", online: true, last: Date.UTC(2026, 8, 27, 2, 12, 2) / 1000 },
    { name: "033", online: true, last: Date.UTC(2026, 8, 27, 2, 11, 51) / 1000 },
  ]);
  assert.deepEqual(parseMiner("Pearl Fortune", 200, fx("pearlfortune_connections_empty.json"), 0), { workers: [], partial: false });
  assert.throws(() => parseMiner("Pearl Fortune", 200, '{"error":"busy"}', 0));
});

test("pools: PearlHash — only connected workers are listed; repeats of a name are numbered", () => {
  const r = parseMiner("PearlHash", 200, fx("pearlhash_account.json"), 0);
  assert.deepEqual(names(r), ["53320", "54353", "54369", "54655", "54655 (2)", "54353 (2)", "54353 (3)", "53320 (2)", "54687"]);
  assert.ok(r.workers.every((w) => w.online && w.last === null));
  assert.deepEqual(parseMiner("PearlHash", 404, "", 0), { missing: true });
  // Unnamed workers are counted, never told apart by IP: an address can change under a rig that never dropped.
  const unnamed = JSON.stringify({ connected_workers: [{ ip: "1.2.3.4" }, { ip: "5.6.7.8", worker_name: " " }, {}] });
  assert.deepEqual(names(parseMiner("PearlHash", 200, unnamed, 0)), [ANON, `${ANON} (2)`, `${ANON} (3)`]);
  const odd = JSON.stringify({ connected_workers: ["constructor", "constructor", "__proto__", "__proto__", "toString"].map((worker_name) => ({ worker_name })) });
  assert.deepEqual(names(parseMiner("PearlHash", 200, odd, 0)), ["constructor", "constructor (2)", "__proto__", "__proto__ (2)", "toString"]);
});

test("pools: an answer that isn't the pool's data is a failed poll, never an empty miner", () => {
  for (const pool of POOLS) {
    assert.throws(() => parseMiner(pool, 500, "{}", 0), /http 500/, pool);
    assert.throws(() => parseMiner(pool, 429, "{}", 0), /http 429/, pool);
    assert.throws(() => parseMiner(pool, 200, "<html>challenge</html>", 0), pool);
    assert.throws(() => parseMiner(pool, 200, "null", 0), pool);
  }
});

test("pools: one name is one worker; a huge list is cut and read as partial", () => {
  const two = JSON.stringify({ results: [{ worker: "r", status: "offline", last_share: 5000 }, { worker: "r", status: "online", last_share: 9000 }] });
  assert.deepEqual(parseMiner("Kryptex", 200, two, 0).workers, [{ name: "r", online: true, last: 9 }]);
  const many = JSON.stringify({ results: Array.from({ length: MAX_WORKERS + 20 }, (_, i) => ({ worker: `w${String(i).padStart(4, "0")}`, status: "online" })) });
  const r = parseMiner("Kryptex", 200, many, 0);
  assert.equal(r.workers.length, MAX_WORKERS);
  assert.equal(r.partial, true);
  assert.equal(r.workers[0].name, "w0000");
});

test("pools: sanitizeTarget takes PRL addresses and F2Pool keys, nothing that could steer a URL", () => {
  const a = "prl1puv0gqv4x0wd0ylwz086y3sqrg4a6umza9r08aecehjrmdqq7mctsmqaqsh";
  assert.equal(sanitizeTarget("Kryptex", a), a);
  for (const bad of [a.toUpperCase(), a + "/../x", a + "?x=1", "bc1qxyz", "", "prl1", null, 7, `${a} `]) {
    assert.equal(sanitizeTarget("Kryptex", bad), null, String(bad));
  }
  assert.equal(sanitizeTarget("TW-Pool", a), null);
  assert.equal(sanitizeTarget("constructor", a), null);
  const key = "0123456789abcdef0123456789abcdef";
  assert.equal(sanitizeTarget("F2Pool", key), key);
  assert.equal(sanitizeTarget("F2Pool", key, "my rig 01"), `${key}/my rig 01`);
  assert.equal(sanitizeTarget("F2Pool", key, ""), key);
  for (const bad of [a, key.toUpperCase(), key + "/x", "https://www.f2pool.com/mining-user-prl/" + key, "abc"]) {
    assert.equal(sanitizeTarget("F2Pool", bad), null, bad);
  }
  assert.equal(sanitizeTarget("F2Pool", key, "a\nb"), null);
  assert.equal(sanitizeTarget("F2Pool", key, "x".repeat(65)), null);
});

// ── state machine ────────────────────────────────────────────────────────────

const up = (name, last = null) => ({ name, online: true, last });
const down = (name, last = null) => ({ name, online: false, last });

test("fold: offline since the last share where the pool gives one, else since we first saw it", () => {
  let s = fold(unpack("{}"), [up("a"), up("b"), up("c")], 1000);
  assert.deepEqual(plain(s), { a: 0, b: 0, c: 0 });
  s = fold(s, [down("a", 900), down("b"), up("c")], 1300);
  assert.deepEqual(plain(s), { a: 900, b: 1300, c: 0 });
  s = fold(s, [down("a", 900), down("b"), up("c")], 1600);
  assert.deepEqual(plain(s), { a: 900, b: 1300, c: 0 }, "an outage keeps its start");
  s = fold(s, [up("a"), up("b"), up("c")], 1900);
  assert.deepEqual(plain(s), { a: 0, b: 0, c: 0 });
  // A last share from the future (clock skew) can't start an outage after now.
  assert.deepEqual(plain(fold(s, [down("a", 5000)], 2000)), { a: 2000, b: 2000, c: 2000 });
});

test("fold: a worker that drops off the list is offline from that poll; a partial list changes nothing", () => {
  const s = fold(unpack("{}"), [up("a"), up("b")], 1000);
  assert.deepEqual(plain(fold(s, [up("a")], 1300)), { a: 0, b: 1300 });
  assert.deepEqual(plain(fold(s, [up("a")], 1300, true)), { a: 0, b: 0 });
  // Listed again as offline with its real last share: the outage starts there.
  assert.deepEqual(plain(fold(fold(s, [up("a")], 1300), [up("a"), down("b", 1100)], 1600)), { a: 0, b: 1100 });
});

test("fold: a worker first seen offline is marked as never up (negative), until it comes online", () => {
  let s = fold(unpack("{}"), [down("dead", 100), down("ghost"), up("a")], 1000);
  assert.deepEqual(plain(s), { dead: -100, ghost: -1000, a: 0 });
  s = fold(s, [down("dead", 100), down("ghost"), up("a")], 1300);
  assert.deepEqual(plain(s), { dead: -100, ghost: -1000, a: 0 });
  s = fold(s, [up("dead"), up("a")], 1600);
  assert.equal(s.dead, 0);
  assert.equal(fold(s, [down("dead", 1650), up("a")], 1900).dead, 1650, "from now on a real outage");
});

test("fold: an offline worker the pool stopped listing is forgotten after a week", () => {
  const s = unpack(JSON.stringify({ old: 1000, older: -1000, on: 0 }));
  const day = 86400;
  assert.deepEqual(plain(fold(s, [up("on")], 1000 + 6 * day)), { on: 0, old: 1000, older: -1000 });
  assert.deepEqual(plain(fold(s, [up("on")], 1000 + 7 * day)), { on: 0 });
  // …also when the pool shows only part of its list: that keeps an unlisted worker
  // as it was, but must not keep a long-gone one for ever.
  assert.deepEqual(plain(fold(s, [], 1000 + 6 * day, true)), { old: 1000, older: -1000, on: 0 });
  assert.deepEqual(plain(fold(s, [], 1000 + 7 * day, true)), { on: 0 });
});

const quiet = { push: [], back: [], still: [], wait: false };

test("due: pushed once the outage has lasted the threshold, and only once", () => {
  const state = { a: 1000, b: 0, c: -500 };
  assert.deepEqual(plain(due(state, {}, 600, 1500)), { ...quiet, told: {} });
  assert.deepEqual(plain(due(state, {}, 600, 1600)), { ...quiet, push: [{ name: "a", since: 1000 }], told: {} });
  assert.deepEqual(plain(due(state, { a: [1000, 1600] }, 600, 1900)), { ...quiet, told: { a: [1000, 1600] } });
  // A longer threshold waits longer; a worker never seen up is never news.
  assert.deepEqual(plain(due(state, {}, 3600, 4000)).push, []);
  assert.deepEqual(plain(due(state, {}, 3600, 4600)).push, [{ name: "a", since: 1000 }]);
});

test("due: what is already down at the first look is noted, not pushed; a fresh outage still is", () => {
  const first = due({ old: 1000, recent: 9800 }, {}, 600, 10_000, true);
  assert.deepEqual(plain(first), { ...quiet, told: { old: [1000, 0] } });
  assert.deepEqual(plain(due({ old: 1000, recent: 9800 }, first.told, 600, 10_400)).push, [{ name: "recent", since: 9800 }]);
  // …and when it comes back, a device that was never told it was down hears nothing.
  assert.deepEqual(plain(due({ old: 0, recent: 9800 }, first.told, 600, 10_100)), { ...quiet, told: {} });
});

test("due: a worker that was pushed as offline is announced as back once it has stayed online", () => {
  const told = { a: [1000, 1600] };
  // First seen online: noted, and the miner is to be looked at again soon.
  const seen = due({ a: 0 }, told, 600, 5000);
  assert.deepEqual(plain(seen), { ...quiet, wait: true, told: { a: [1000, 1600, 5000] } });
  // Too soon to say…
  assert.deepEqual(plain(due({ a: 0 }, seen.told, 600, 5000 + STEADY - 1)), { ...quiet, wait: true, told: { a: [1000, 1600, 5000] } });
  // …then still there: back, offline from 1000 until the poll that found it.
  const back = due({ a: 0 }, seen.told, 600, 5000 + RECHECK);
  assert.deepEqual(plain(back), { ...quiet, back: [{ name: "a", since: 1000, at: 5000 }], told: { a: [1000, 1600, 5000] } });
  // Not sent (quiet hours, say): it is owed for as long as the worker stays online.
  assert.deepEqual(plain(due({ a: 0 }, back.told, 600, 9000)).back, [{ name: "a", since: 1000, at: 5000 }]);
  // Sent, the cool-down long over: nothing more to remember.
  assert.deepEqual(plain(tell(back.told, [], back.back, 5060)), {});
  assert.ok(STEADY < RECHECK && RECHECK < 120, "the second look comes a minute on, and counts");
});

test("due: a worker that only flickers online is not announced, and dropping again is not news", () => {
  const seen = due({ a: 0 }, { a: [1000, 1600] }, 600, 5000);
  // Offline again at the second look — a new outage by its start, and long past the
  // cool-down: the device still thinks it is offline, so it hears nothing…
  const again = due({ a: 5020 }, seen.told, 600, 5060);
  assert.deepEqual(plain(again), { ...quiet, told: { a: [1000, 1600] } });
  assert.deepEqual(plain(due({ a: 5020 }, again.told, 600, 9000)), { ...quiet, told: { a: [1000, 1600] } });
  // …until it is back for good: the stay is timed from the start, and the outage from the first drop.
  const up = due({ a: 0 }, again.told, 600, 9180);
  assert.deepEqual(plain(up), { ...quiet, wait: true, told: { a: [1000, 1600, 9180] } });
  assert.deepEqual(plain(due({ a: 0 }, up.told, 600, 9240)).back, [{ name: "a", since: 1000, at: 9180 }]);
});

test("due: a worker that comes back and drops again rings again only after the cool-down", () => {
  // Pushed as offline at 1600, back at 1800, told so at 1860.
  const ready = due({ a: 0 }, { a: [1000, 1600, 1800] }, 600, 1860);
  const told = plain(tell(ready.told, [], ready.back, 1860));
  assert.deepEqual(told, { a: [1000, 1600, 1800, 1860] });
  // Online: the entry is kept while it cools, and says nothing twice.
  assert.deepEqual(plain(due({ a: 0 }, told, 600, 2000)), { ...quiet, told });
  assert.deepEqual(plain(due({ a: 0 }, told, 600, 1600 + COOLDOWN)), { ...quiet, told: {} });
  // A second outage, long enough, inside the cool-down: held back…
  assert.deepEqual(plain(due({ a: 2000 }, told, 600, 2700)), { ...quiet, told });
  // …and pushed as soon as the cool-down is over, if it is still down.
  assert.deepEqual(plain(due({ a: 2000 }, told, 600, 1600 + COOLDOWN)), { ...quiet, push: [{ name: "a", since: 2000 }], told: {} });
  // Back before that push went out: the device was never told it dropped, so it isn't told it returned.
  assert.deepEqual(plain(due({ a: 0 }, due({ a: 2000 }, told, 600, 2700).told, 600, 2900)), { ...quiet, told });
  // A worker that reconnected without a share and dropped again shows the old last share: still a new outage.
  assert.deepEqual(plain(due({ a: 1000 }, told, 600, 1600 + COOLDOWN)).push, [{ name: "a", since: 1000 }]);
});

test("due: raising the threshold doesn't re-announce an outage that was already told", () => {
  const told = { a: [1000, 1600] };
  assert.deepEqual(plain(due({ a: 1000 }, told, 3600, 1600 + COOLDOWN + 60)), { ...quiet, told });
  assert.deepEqual(plain(due({ a: 1000 }, told, 3600, 5000)), { ...quiet, told });
});

test("due: a reminder goes out once, `again` after the first push, while the worker is still offline", () => {
  const told = { a: [1000, 1600] };
  assert.deepEqual(plain(due({ a: 1000 }, told, 600, 1600 + 3599, false, 3600)), { ...quiet, told });
  const r = due({ a: 1000 }, told, 600, 1600 + 3600, false, 3600);
  assert.deepEqual(plain(r), { ...quiet, still: [{ name: "a", since: 1000 }], told });
  // Sent: once is all.
  const after = tell(r.told, [], [], 5200, r.still);
  assert.deepEqual(plain(after), { a: [1000, 1600, 0, 0, 5200] });
  assert.deepEqual(plain(due({ a: 1000 }, after, 600, 99_000, false, 3600)), { ...quiet, told: plain(after) });
  // Not sent (quiet hours, say): still owed at the next poll, while the worker stays down.
  assert.deepEqual(plain(due({ a: 1000 }, told, 600, 9000, false, 3600)).still, [{ name: "a", since: 1000 }]);
  // …and the return is still told, timed from the first drop, and then forgotten.
  const seen = due({ a: 0 }, after, 600, 6000, false, 3600);
  assert.deepEqual(plain(seen), { ...quiet, wait: true, told: { a: [1000, 1600, 6000, 0, 5200] } });
  const back = due({ a: 0 }, seen.told, 600, 6060, false, 3600);
  assert.deepEqual(plain(back.back), [{ name: "a", since: 1000, at: 6000 }]);
  assert.deepEqual(plain(tell(back.told, [], back.back, 6060)), {});
  // Back before the reminder was due: nothing to remind about.
  assert.deepEqual(plain(due({ a: 0 }, told, 600, 5200, false, 3600)).still, []);
});

test("due: a worker that flickers after the reminder is still the same outage — no second reminder", () => {
  const told = { a: [1000, 1600, 0, 0, 5200] };
  const seen = due({ a: 0 }, told, 600, 6000, false, 1800);
  assert.deepEqual(plain(seen.told), { a: [1000, 1600, 6000, 0, 5200] });
  const down = due({ a: 6020 }, seen.told, 600, 6060, false, 1800);
  assert.deepEqual(plain(down), { ...quiet, told });
  assert.deepEqual(plain(due({ a: 6020 }, down.told, 600, 50_000, false, 1800)), { ...quiet, told });
  // Flickering before the reminder doesn't put it off: it counts from the first push.
  const early = due({ a: 0 }, { a: [1000, 1600] }, 600, 2000, false, 1800);
  assert.deepEqual(plain(due({ a: 2020 }, early.told, 600, 1600 + 1800, false, 1800)).still, [{ name: "a", since: 1000 }]);
});

test("due: no reminder when it is off, for an outage only noted, or for one pushed before it was switched on", () => {
  const told = { a: [1000, 1600], b: [500, 0] };
  assert.deepEqual(plain(due({ a: 1000, b: 500 }, told, 600, 90_000)).still, []);
  assert.deepEqual(plain(due({ a: 1000, b: 500 }, told, 600, 90_000, false, 1800)).still, [{ name: "a", since: 1000 }]);
  // Switched on at 2000, after the push at 1600: that outage was known.
  assert.deepEqual(plain(due({ a: 1000 }, told, 600, 90_000, false, 1800, 2000)).still, []);
  assert.deepEqual(plain(due({ a: 1000 }, told, 600, 90_000, false, 1800, 1600)).still, [{ name: "a", since: 1000 }]);
  // An entry an older worker wrote (no reminder field) reads as not reminded.
  assert.deepEqual(plain(due({ a: 1000 }, { a: [1000, 1600, 0, 0] }, 600, 90_000, false, 1800)).still, [{ name: "a", since: 1000 }]);
});

test("tell: an outage pushed is known from then on; a return is remembered only while the cool-down runs", () => {
  const told = { a: [1000, 1600, 1800], b: [1000, 1600, 9000], c: [500, 0] };
  const next = tell(told, [{ name: "d", since: 1700 }], [{ name: "a", since: 1000, at: 1800 }, { name: "b", since: 1000, at: 9000 }], 9060);
  assert.deepEqual(plain(next), { c: [500, 0], d: [1700, 9060] });
  assert.deepEqual(plain(tell(told, [], [{ name: "a", since: 1000, at: 1800 }], 1860)).a, [1000, 1600, 1800, 1860]);
  assert.deepEqual(plain(tell({ e: [800, 1600] }, [], [], 9060, [{ name: "e", since: 800 }])), { e: [800, 1600, 0, 0, 9060] });
  assert.deepEqual(plain(told), { a: [1000, 1600, 1800], b: [1000, 1600, 9000], c: [500, 0] }, "the input is left alone");
  assert.deepEqual(plain(tell(unpack('{"__proto__":[1,2,3]}'), [{ name: "constructor", since: 5 }], [{ name: "__proto__", since: 1, at: 3 }], 4)),
                   plain(unpack('{"__proto__":[1,2,3,4],"constructor":[5,4]}')), "names are data here too");
});

test("watch: an unchanged subscription is not rewritten when the pool lists its workers in another order", async () => {
  setNow(T0);
  const net = installFetch();
  let writes = 0;
  const env = makeEnv({}, { before: (sql) => { if (sql.startsWith("UPDATE watches SET told")) writes++; } });
  let rigs = [["a", true, T0], ["b", true, T0], ["c", true, T0]];
  net.pool = () => kx(rigs);
  await watch(env, tok(1), [K()]);
  await tick(env);
  rigs = [["a", false, T0 + 10], ["b", false, T0 + 20], ["c", true, T0 + 600]];
  await at(env, T0 + 300);
  await at(env, T0 + 660);
  assert.equal(net.alerts().length, 1);
  const told = sub(env, tok(1)).told;
  assert.ok(writes > 0, "the first look and the push were recorded");
  const before = writes;
  rigs = [["c", true, T0 + 900], ["b", false, T0 + 20], ["a", false, T0 + 10]];     // same state, listed backwards
  await at(env, T0 + 960);
  assert.equal(sub(env, tok(1)).told, told);
  assert.equal(writes, before, "nothing to write");
  assert.equal(net.alerts().length, 1);
});

test("state: worker names are data — __proto__ and constructor are tracked like any other", () => {
  let s = fold(unpack("{}"), [up("__proto__"), up("constructor"), up("toString")], 1000);
  s = fold(unpack(JSON.stringify(s)), [], 1300);
  assert.deepEqual(Object.keys(s).sort(), ["__proto__", "constructor", "toString"]);
  const res = due(s, unpack("{}"), 600, 1900);
  assert.deepEqual(res.push.map((p) => p.name).sort(), ["__proto__", "constructor", "toString"]);
  const again = fold(s, [up("__proto__"), up("constructor"), up("toString")], 2200);
  const seen = due(again, tell(res.told, res.push, [], 1900), 600, 2200);
  assert.deepEqual(due(again, seen.told, 600, 2260).back.map((p) => p.name).sort(), ["__proto__", "constructor", "toString"]);
});

test("sanitizeWatch: id, pool, target, label and threshold", () => {
  const a = "prl1puv0gqv4x0wd0ylwz086y3sqrg4a6umza9r08aecehjrmdqq7mctsmqaqsh";
  assert.deepEqual(sanitizeWatch({ id: "W-1", pool: "Kryptex", addr: a, label: "  机房 A\n", after: 1800 }),
                   { id: "W-1", pool: "Kryptex", addr: a, label: "机房 A", after: 1800, again: 0 });
  assert.equal(sanitizeWatch({ id: "w", pool: "Kryptex", addr: a }).after, 600);
  assert.equal(sanitizeWatch({ id: "w", pool: "Kryptex", addr: a, after: 60 }).after, 600, "no threshold under 10 min");
  assert.deepEqual(AFTER, [600, 900, 1800, 3600, 5400, 7200], "10 min up to 2 h");
  assert.equal(sanitizeWatch({ id: "w", pool: "Kryptex", addr: a, after: 7200 }).after, 7200);
  assert.equal(sanitizeWatch({ id: "w", pool: "Kryptex", addr: a, after: 10800 }).after, 600, "nothing past 2 h");
  // The reminder: one of the delays on offer, else none.
  assert.deepEqual(AGAIN, [1800, 3600, 7200, 14400]);
  assert.equal(sanitizeWatch({ id: "w", pool: "Kryptex", addr: a, again: 3600 }).again, 3600);
  for (const v of [undefined, 0, 60, "3600", -3600, 86400]) assert.equal(sanitizeWatch({ id: "w", pool: "Kryptex", addr: a, again: v }).again, 0, String(v));
  assert.equal(sanitizeWatch({ id: "w", pool: "Kryptex", addr: a, label: "x".repeat(99) }).label.length, 40);
  for (const bad of [null, {}, { id: "w", pool: "Nope", addr: a }, { id: "a b", pool: "Kryptex", addr: a },
                     { id: "w", pool: "Kryptex", addr: "x" }, { id: "w", pool: ["Kryptex"], addr: a }]) {
    assert.equal(sanitizeWatch(bad), null, JSON.stringify(bad));
  }
  assert.equal(sanitizeWatch({ id: "w", pool: "F2Pool", addr: "0123456789abcdef0123456789abcdef", acct: "terry" }).addr,
               "0123456789abcdef0123456789abcdef/terry");
});

// ── push copy ────────────────────────────────────────────────────────────────

test("i18n: offline pushes in every language; no 'miner' / 'mining' outside Chinese", () => {
  const w = { id: "w1", pool: "Kryptex", label: "" };
  const one = [{ name: "rig-a", since: 1000 }];
  const five = ["a", "b", "c", "d", "e"].map((name, i) => ({ name, since: 1000 + i }));
  assert.deepEqual(offlinePayloadFor("en", w, one, 1760), {
    aps: { alert: { title: "🔴 rig-a offline", subtitle: "Kryptex", body: "Offline for 12 min" }, sound: "default", "thread-id": "worker-offline" },
    watch: { id: "w1", n: 1 },
  });
  assert.deepEqual(offlinePayloadFor("zh-Hans", { ...w, label: "机房 A" }, five, 4960).aps.alert,
                   { title: "🔴 5 台矿机掉线", subtitle: "机房 A", body: "a、b、c 等 5 台\n最长已离线 1 小时 6 分钟" });
  assert.equal(offlinePayloadFor("en", w, five, 1700).aps.alert.body, "a, b, c +2\nLongest: 11 min");
  const plainNames = [[{ name: "node-7", since: 1000 }], five];
  for (const lang of LANGS) {
    for (const d of plainNames) {
      const { title, body } = offlinePayloadFor(lang, w, d, 2000).aps.alert;
      assert.ok(title && body, lang);
      if (!lang.startsWith("zh")) assert.doesNotMatch(`${title} ${body}`, /\bmin(er|ing)\b|\brig\b/i, lang);
    }
  }
  assert.equal(offlinePayloadFor("xx", w, one, 1760).aps.alert.title, "🔴 rig-a offline");
  assert.equal(offlinePayloadFor("en", w, [{ name: `${ANON} (2)`, since: 1000 }], 1760).aps.alert.title, "🔴 unnamed (2) offline");
  assert.equal(offlinePayloadFor("zh-Hans", w, [{ name: ANON, since: 1000 }], 1760).aps.alert.title, "🔴 未命名 掉线");
  assert.equal(offlinePayloadFor("en", w, [{ name: "x".repeat(80), since: 1000 }], 1760).aps.alert.title.length, "🔴  offline".length + 32);
  assert.deepEqual([fmtAgo("en", 30), fmtAgo("en", 3600), fmtAgo("en", 3900), fmtAgo("zh-Hans", 3 * 86400)], ["1 min", "1 h", "1 h 5 min", "3 天"]);
  // Korean and Japanese write the unit against its number.
  assert.deepEqual([fmtAgo("ko", 750), fmtAgo("ko", 3900), fmtAgo("ja", 3900), fmtAgo("ja", 3 * 86400)], ["12분", "1시간 5분", "1時間5分", "3日"]);
  assert.equal(offlinePayloadFor("ko", w, [{ name: "rig-a", since: 1000 }], 1750).aps.alert.body, "12분째 오프라인");
  assert.equal(offlinePayloadFor("de", w, [{ name: "rig-a", since: 1000 }], 1750).aps.alert.body, "Seit 12 Min. offline");
});

test("i18n: back-online pushes in every language, with how long the outage lasted", () => {
  const w = { id: "w1", pool: "Kryptex", label: "" };
  const one = [{ name: "rig-a", since: 1000, at: 2500 }];
  const five = ["a", "b", "c", "d", "e"].map((name, i) => ({ name, since: 1000 + i, at: 4960 }));
  assert.deepEqual(onlinePayloadFor("en", w, one), {
    aps: { alert: { title: "🟢 rig-a back online", subtitle: "Kryptex", body: "Was offline for 25 min" }, sound: "default", "thread-id": "worker-offline" },
    watch: { id: "w1", n: 1, back: true },
  });
  assert.deepEqual(onlinePayloadFor("zh-Hans", { ...w, label: "机房 A" }, one).aps.alert,
                   { title: "🟢 rig-a 恢复上线", subtitle: "机房 A", body: "共离线 25 分钟" });
  assert.deepEqual(onlinePayloadFor("zh-Hans", { ...w, label: "机房 A" }, five).aps.alert,
                   { title: "🟢 5 台矿机恢复上线", subtitle: "机房 A", body: "a、b、c 等 5 台\n最长离线 1 小时 6 分钟" });
  assert.equal(onlinePayloadFor("en", w, five).aps.alert.body, "a, b, c +2\nLongest outage: 1 h 6 min");
  // Each worker's own outage counts, not the earliest start against the latest return.
  const apart = [{ name: "a", since: 1000, at: 1600 }, { name: "b", since: 5000, at: 6800 }];
  assert.equal(onlinePayloadFor("en", w, apart).aps.alert.body, "a, b\nLongest outage: 30 min");
  const titles = new Set();
  for (const lang of LANGS) {
    for (const d of [[{ name: "node-7", since: 1000, at: 2000 }], five]) {
      const { title, body } = onlinePayloadFor(lang, w, d).aps.alert;
      assert.ok(title && body, lang);
      assert.notEqual(title, offlinePayloadFor(lang, w, d, 2000).aps.alert.title, lang);
      if (!lang.startsWith("zh")) assert.doesNotMatch(`${title} ${body}`, /\bmin(er|ing)\b|\brig\b/i, lang);
      titles.add(title);
    }
  }
  assert.equal(titles.size, LANGS.length * 2, "every language has its own copy");
  assert.equal(onlinePayloadFor("xx", w, one).aps.alert.title, "🟢 rig-a back online");
  assert.equal(onlinePayloadFor("zh-Hant", w, [{ name: ANON, since: 1000, at: 1760 }]).aps.alert.title, "🟢 未命名 恢復上線");
});

test("i18n: still-offline reminders in every language, in the offline thread", () => {
  const w = { id: "w1", pool: "Kryptex", label: "" };
  assert.deepEqual(stillPayloadFor("en", w, [{ name: "rig-a", since: 1000 }], 1000 + 4500), {
    aps: { alert: { title: "🔴 rig-a still offline", subtitle: "Kryptex", body: "Offline for 1 h 15 min" }, sound: "default", "thread-id": "worker-offline" },
    watch: { id: "w1", n: 1, still: true },
  });
  assert.deepEqual(stillPayloadFor("zh-Hans", { ...w, label: "机房 A" }, [{ name: "a", since: 1000 }, { name: "b", since: 2000 }], 1000 + 7200).aps.alert,
                   { title: "🔴 2 台矿机仍未恢复", subtitle: "机房 A", body: "a、b\n最长已离线 2 小时" });
  const titles = new Set();
  for (const lang of LANGS) {
    for (const d of [[{ name: "node-7", since: 1000 }], [{ name: "a", since: 1000 }, { name: "b", since: 1500 }]]) {
      const { title, body } = stillPayloadFor(lang, w, d, 9000).aps.alert;
      assert.ok(title && body, lang);
      assert.notEqual(title, offlinePayloadFor(lang, w, d, 9000).aps.alert.title, lang);
      if (!lang.startsWith("zh")) assert.doesNotMatch(`${title} ${body}`, /\bmin(er|ing)\b|\brig\b/i, lang);
      titles.add(title);
    }
  }
  assert.equal(titles.size, LANGS.length * 2, "every language has its own copy");
});

// ── end to end ───────────────────────────────────────────────────────────────

const addr = (i) => "prl1p" + i.toString(36).padStart(40, "q");
const kx = (workers) => Response.json({
  results: workers.map(([worker, online, last]) => ({ worker, scheme: "pps", status: online ? "online" : "offline", last_share: (last || 0) * 1000 })),
});
const K = (id = "w1", extra = {}) => ({ id, pool: "Kryptex", addr: addr(1), label: "", after: 600, ...extra });
const sub = (env, token, id = "w1") => env.DB.one("SELECT told, base FROM watches WHERE token = ? AND id = ?", token, id);
const miner = (env, a = addr(1), pool = "Kryptex") => env.DB.one("SELECT workers, tried_at, checked_at, missing FROM miners WHERE pool = ? AND addr = ?", pool, a);
async function at(env, t) { setNow(t); await tick(env); }

test("watch: a worker offline for 10 min is pushed once; coming back and dropping again waits for the cool-down", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  let rigs = [["a", true, T0 - 5], ["b", true, T0 - 9]];
  net.pool = () => kx(rigs);
  assert.deepEqual(await watch(env, tok(1), [K()]), { status: 200, body: { ok: true, rules: [], watches: [{ id: "w1", pool: "Kryptex", after: 600, checked_at: null, missing: false, stale: false }] } });

  await tick(env);
  assert.equal(net.polls.length, 1);
  assert.equal(net.polls[0].url, `https://prl-api.kryptex.network/api/v3/miner/workers/${addr(1)}`);
  assert.match(net.polls[0].headers["user-agent"], /^PearlHubAlerts\//);
  assert.deepEqual(plain(sub(env, tok(1))), { told: "{}", base: 1 });
  assert.deepEqual(miner(env), { workers: '{"a":0,"b":0}', tried_at: T0, checked_at: T0, missing: 0 });

  await at(env, T0 + 60);
  await at(env, T0 + 120);
  assert.equal(net.polls.length, 1, "each miner is polled every 3 min, not every tick");
  await at(env, T0 + 180);
  assert.equal(net.polls.length, 2, "…and again once its 3 min are up");

  rigs = [["a", false, T0 + 100], ["b", true, T0 + 290]];
  await at(env, T0 + 300);          // 120 s after the last poll: not this miner's turn
  assert.equal(net.polls.length, 2);
  await at(env, T0 + 360);
  await at(env, T0 + 600);
  assert.equal(net.polls.length, 4);
  assert.equal(net.alerts().length, 0, "offline for 500 s: not yet");
  assert.equal(env.DB.rows("SELECT k FROM kv WHERE k LIKE 'sent:%'").length, 0, "nothing pushed, nothing recorded");

  await at(env, T0 + 900);
  assert.equal(net.alerts().length, 1);
  const push = net.alerts()[0];
  assert.equal(push.token, tok(1));
  assert.deepEqual(push.body.aps.alert, { title: "🔴 a offline", subtitle: "Kryptex", body: "Offline for 13 min" });
  assert.deepEqual(push.body.watch, { id: "w1", n: 1 });
  assert.equal(push.headers["apns-collapse-id"], undefined, "a second outage must not replace the first notification");
  assert.equal(sub(env, tok(1)).told, JSON.stringify({ a: [T0 + 100, T0 + 900] }));
  // What APNs made of it stays readable (the worker's logs can't always be tailed).
  assert.deepEqual(env.DB.rows("SELECT k, v, ts FROM kv WHERE k LIKE 'sent:%'").map((r) => [r.k, JSON.parse(r.v), r.ts]),
    [[`sent:${T0 + 900}`, { pushes: [{ tok: tok(1).slice(0, 8), watch: "w1", n: 1, ok: true, env: "production" }], lost: 0 }, T0 + 900]]);

  await at(env, T0 + 1200);
  await at(env, T0 + 1500);
  assert.equal(net.alerts().length, 1, "one push per outage");

  rigs = [["a", true, T0 + 1790], ["b", true, T0 + 1790]];
  await at(env, T0 + 1800);
  assert.equal(net.alerts().length, 1, "back, but only just");
  assert.equal(net.polls.length, 8);
  await at(env, T0 + 1860);          // …so the miner is looked at again a minute on, not 3
  assert.equal(net.polls.length, 9);
  assert.equal(net.alerts().length, 2);
  assert.deepEqual(net.alerts()[1].body.aps.alert, { title: "🟢 a back online", subtitle: "Kryptex", body: "Was offline for 28 min" });
  assert.deepEqual(net.alerts()[1].body.watch, { id: "w1", n: 1, back: true });
  assert.equal(sub(env, tok(1)).told, JSON.stringify({ a: [T0 + 100, T0 + 900, T0 + 1800, T0 + 1860] }));
  assert.deepEqual(JSON.parse(env.DB.one("SELECT v FROM kv WHERE k = ?", `sent:${T0 + 1860}`).v),
    { pushes: [{ tok: tok(1).slice(0, 8), watch: "w1", n: 1, back: true, ok: true, env: "production" }], lost: 0 });
  await at(env, T0 + 1920);
  await at(env, T0 + 1980);
  assert.equal(net.polls.length, 9, "after that it is back to every 3 min");
  await at(env, T0 + 2040);
  assert.equal(net.polls.length, 10);
  assert.equal(net.alerts().length, 2, "back is said once");

  rigs = [["a", false, T0 + 2050], ["b", true, T0 + 2210]];
  await at(env, T0 + 2220);
  await at(env, T0 + 2400);          // 350 s into the second outage
  await at(env, T0 + 2580);          // 530 s
  assert.equal(net.alerts().length, 2);
  await at(env, T0 + 2760);          // 710 s, and past the cool-down (30 min after the first push)
  assert.equal(net.alerts().length, 3);
  assert.equal(net.alerts()[2].body.aps.alert.body, "Offline for 11 min");
  assert.equal(sub(env, tok(1)).told, JSON.stringify({ a: [T0 + 2050, T0 + 2760] }), "a new outage, to be answered by a new return");
});

test("watch: a worker that flickers online is announced only when it stays; meanwhile its drops are not news", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  let rigs = [["a", true, T0]];
  net.pool = () => kx(rigs);
  await watch(env, tok(1), [K("w1", { label: "Garage" })], { lang: "zh-Hans" });
  await tick(env);
  rigs = [["a", false, T0 + 10]];
  await at(env, T0 + 180);
  for (let t = 360; t <= 720; t += 180) await at(env, T0 + t);
  assert.deepEqual(net.alerts().map((c) => c.body.aps.alert.title), ["🔴 a 掉线"]);

  // Two hours on it starts flapping: online at one look, gone at the next, three times over.
  let t = T0 + 7200;
  for (let i = 0; i < 3; i++) {
    rigs = [["a", true, t]];
    await at(env, t);
    rigs = [["a", false, t + 30]];
    await at(env, t + 60);
    for (let k = 1; k <= 5; k++) await at(env, t + 60 + k * 180);     // 15 min down each time: longer than the threshold
    t += 1140;
  }
  assert.equal(net.polls.length, 5 + 3 * 7, "every one of those looks was a poll");
  assert.equal(net.alerts().length, 1, "neither 'back' nor 'offline' again");
  assert.equal(sub(env, tok(1)).told, JSON.stringify({ a: [T0 + 10, T0 + 720] }));

  // Then it stays.
  rigs = [["a", true, t]];
  await at(env, t);
  await at(env, t + 60);
  assert.deepEqual(net.alerts().slice(1).map((c) => c.body.aps.alert), [{ title: "🟢 a 恢复上线", subtitle: "Garage", body: "共离线 2 小时 56 分钟" }]);
  assert.equal(sub(env, tok(1)).told, "{}", "long past the cool-down: nothing left to remember");
  for (let k = 1; k <= 3; k++) await at(env, t + 60 + k * 180);
  assert.equal(net.alerts().length, 2);
});

test("watch: only a device that was told about the outage hears that it is over", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  let rigs = [["a", true, T0], ["b", true, T0]];
  net.pool = () => kx(rigs);
  await watch(env, tok(1), [K()]);                                  // 10 min
  await watch(env, tok(2), [K("slow", { after: 3600 })]);            // 60 min: never reached
  await tick(env);
  rigs = [["a", false, T0 + 10], ["b", false, T0 + 20]];
  await at(env, T0 + 180);
  // tok(3) joins mid-outage: for it both were already down.
  setNow(T0 + 700);
  await watch(env, tok(3), [K("late")]);
  await at(env, T0 + 720);
  assert.deepEqual(net.alerts().map((c) => [c.token, c.body.aps.alert.title]), [[tok(1), "🔴 2 workers offline"]]);
  rigs = [["a", true, T0 + 890], ["b", true, T0 + 895]];
  await at(env, T0 + 900);
  await at(env, T0 + 957);           // the next tick, which is never exactly a minute on
  assert.deepEqual(net.alerts().slice(1).map((c) => [c.token, c.body.aps.alert.title, c.body.aps.alert.body]),
                   [[tok(1), "🟢 2 workers back online", "a, b\nLongest outage: 14 min"]]);
  assert.equal(net.polls.length, 5, "the second look is one poll, however many devices watch the miner");
  for (let k = 1; k <= 4; k++) await at(env, T0 + 960 + k * 180);
  assert.equal(net.alerts().length, 2);
});

test("watch: a return in quiet hours is told when the window opens — if the worker is still online then", async () => {
  // T0 is 08:00 in Shanghai. The window closes at 08:30 and opens again at 09:30.
  const window = { start: 9 * 60 + 30, end: 8 * 60 + 30, tz: "Asia/Shanghai" };
  for (const stays of [true, false]) {
    setNow(T0);
    const net = installFetch();
    const env = makeEnv();
    let rigs = [["a", true, T0]];
    net.pool = () => kx(rigs);
    await watch(env, tok(1), [K()], { window });
    await tick(env);
    rigs = [["a", false, T0 + 10]];
    for (let t = 180; t <= 720; t += 180) await at(env, T0 + t);
    assert.equal(net.alerts().length, 1, "08:12 — told it is offline");
    rigs = [["a", true, T0 + 2390]];
    await at(env, T0 + 2400);        // 08:40
    await at(env, T0 + 2460);
    for (let t = 2640; t < 5400; t += 180) await at(env, T0 + t);
    assert.equal(net.alerts().length, 1, "quiet hours");
    assert.equal(sub(env, tok(1)).told, JSON.stringify({ a: [T0 + 10, T0 + 720, T0 + 2400] }));
    if (!stays) rigs = [["a", false, T0 + 5300]];
    await at(env, T0 + 5400);        // 09:30
    await at(env, T0 + 5580);
    if (stays) assert.deepEqual(net.alerts().slice(1).map((c) => c.body.aps.alert.body), ["Was offline for 39 min"]);
    else assert.equal(net.alerts().length, 1, "down again before anyone was told it was up");
    restoreNow();
  }
});

test("watch: a back-online push APNs didn't take is tried again at the next poll", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  let rigs = [["a", true, T0]];
  net.pool = () => kx(rigs);
  await watch(env, tok(1), [K()]);
  await tick(env);
  rigs = [["a", false, T0 + 10]];
  for (let t = 180; t <= 720; t += 180) await at(env, T0 + t);
  assert.deepEqual(net.alerts().map((c) => c.body.aps.alert.title), ["🔴 a offline"]);
  rigs = [["a", true, T0 + 890]];
  await at(env, T0 + 900);
  net.apns = () => ({ status: 503, reason: "ServiceUnavailable" });
  await at(env, T0 + 960);
  assert.equal(net.alerts().length, 2, "tried");
  assert.equal(sub(env, tok(1)).told, JSON.stringify({ a: [T0 + 10, T0 + 720, T0 + 900] }), "still owed");
  assert.deepEqual(JSON.parse(env.DB.one("SELECT v FROM kv WHERE k = ?", `sent:${T0 + 960}`).v).pushes,
    [{ tok: tok(1).slice(0, 8), watch: "w1", n: 1, back: true, ok: false, status: 503, reason: "ServiceUnavailable", verdict: "retry" }]);
  net.apns = () => ({ status: 200 });
  await at(env, T0 + 1020);
  assert.equal(net.alerts().length, 2, "not this miner's turn: one early look per return, not one a minute");
  await at(env, T0 + 1140);
  assert.deepEqual(net.alerts().slice(2).map((c) => c.body.aps.alert.title), ["🟢 a back online"]);
  await at(env, T0 + 1320);
  assert.equal(net.alerts().length, 3);
});

test("watch: one going down as another comes back are two pushes; if only one gets through, only the other is repeated", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  let rigs = [["a", true, T0], ["b", true, T0]];
  net.pool = () => kx(rigs);
  await watch(env, tok(1), [K()]);
  await tick(env);
  rigs = [["a", false, T0 + 10], ["b", true, T0 + 700]];
  for (let t = 180; t <= 720; t += 180) await at(env, T0 + t);
  // `a` is seen back at 900 and holds; `b`, gone since 760, reaches 10 min at the look at 1380.
  rigs = [["a", true, T0 + 890], ["b", false, T0 + 760]];
  await at(env, T0 + 900);
  // The second look fails (the pool hiccups): the return waits for the next regular one.
  const pool = net.pool;
  net.pool = () => new Response("{}", { status: 500 });
  await at(env, T0 + 960);
  net.pool = pool;
  assert.equal(net.alerts().length, 1);
  await at(env, T0 + 1140);
  assert.deepEqual(net.alerts().slice(1).map((c) => c.body.aps.alert.title), ["🟢 a back online"]);
  // Now both at once, for a device whose two monitors share the miner.
  await watch(env, tok(1), [K(), K("w2", { label: "Twin" })]);
  env.DB.raw.prepare("UPDATE watches SET base = 1, told = ? WHERE id = 'w2'").run(JSON.stringify({ a: [T0 + 10, T0 + 720, T0 + 900] }));
  net.apns = (c) => (c.body.watch.id === "w2" && !c.body.watch.back ? { status: 503, reason: "ServiceUnavailable" } : { status: 200 });
  await at(env, T0 + 1380);
  const got = net.alerts().slice(2).map((c) => [c.body.watch.id, c.body.aps.alert.title]).sort();
  assert.deepEqual(got, [["w1", "🔴 b offline"], ["w2", "🔴 b offline"], ["w2", "🟢 a back online"]]);
  assert.equal(sub(env, tok(1), "w2").told, JSON.stringify({ a: [T0 + 10, T0 + 720, T0 + 900, T0 + 1380] }), "the return is told; the outage is still to tell");
  net.apns = () => ({ status: 200 });
  await at(env, T0 + 1560);
  assert.deepEqual(net.alerts().slice(5).map((c) => [c.body.watch.id, c.body.aps.alert.title]), [["w2", "🔴 b offline"]]);
});

test("watch: what was already down when the alert was switched on is never pushed", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  net.pool = () => kx([["dead", false, T0 - 86400], ["a", true, T0]]);
  await watch(env, tok(1), [K()]);
  for (let i = 0; i <= 6; i++) await at(env, T0 + i * 300);
  assert.equal(net.alerts().length, 0);
  assert.equal(miner(env).workers, JSON.stringify({ dead: -(T0 - 86400), a: 0 }));
});

test("watch: a second device joining a miner mid-outage hears only what is still news", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  let rigs = [["old", true, T0], ["new", true, T0]];
  net.pool = () => kx(rigs);
  await watch(env, tok(1), [K()]);
  await tick(env);
  rigs = [["old", false, T0 + 10], ["new", true, T0 + 890]];
  await at(env, T0 + 300);
  await at(env, T0 + 900);
  assert.deepEqual(net.alerts().map((c) => c.token), [tok(1)]);

  // tok(2) switches the alert on now: `old` has been down 15 min (not news), `new` drops 4 min ago.
  rigs = [["old", false, T0 + 10], ["new", false, T0 + 950]];
  setNow(T0 + 1190);
  await watch(env, tok(2), [K("mine", { label: "Garage" })]);
  await at(env, T0 + 1200);
  assert.equal(net.alerts().length, 1);
  assert.equal(sub(env, tok(2), "mine").told, JSON.stringify({ old: [T0 + 10, 0] }));
  await at(env, T0 + 1500);
  assert.equal(net.alerts().length, 1, "`new`: 550 s");
  await at(env, T0 + 1800);
  const got = net.alerts().slice(1).map((c) => [c.token, c.body.aps.alert.title, c.body.aps.alert.subtitle, c.body.aps.alert.body]).sort();
  assert.deepEqual(got, [
    [tok(1), "🔴 new offline", "Kryptex", "Offline for 14 min"],
    [tok(2), "🔴 new offline", "Garage", "Offline for 14 min"],
  ]);
  assert.equal(net.polls.length, 6, "one poll per miner, however many devices watch it");
});

test("watch: several workers dropping together make one push, longest outage first", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  let rigs = ["a", "b", "c", "d", "e"].map((n) => [n, true, T0]);
  net.pool = () => kx(rigs);
  await watch(env, tok(1), [K("w1", { label: "Farm" })], { lang: "zh-Hans" });
  await tick(env);
  rigs = [["a", false, T0 + 30], ["b", false, T0 + 20], ["c", false, T0 + 20], ["d", false, T0 + 10], ["e", true, T0 + 600]];
  await at(env, T0 + 300);
  await at(env, T0 + 660);
  assert.equal(net.alerts().length, 1);
  assert.deepEqual(net.alerts()[0].body.aps.alert, { title: "🔴 4 台矿机掉线", subtitle: "Farm", body: "d、b、c 等 4 台\n最长已离线 10 分钟" });
  assert.deepEqual(net.alerts()[0].body.watch, { id: "w1", n: 4 });
});

test("watch: a pool that fails or rate-limits never reads as offline, and is left alone", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  let mode = "ok";
  net.pool = () => (mode === "ok" ? kx([["a", true, T0]]) : mode === "html" ? new Response("<html>challenge</html>") : new Response("{}", { status: Number(mode) }));
  await watch(env, tok(1), Array.from({ length: 20 }, (_, i) => K(`w${i}`, { addr: addr(i) })));
  await tick(env);
  assert.equal(net.polls.length, 20);

  // 500, a challenge page, and a 404 Kryptex never sends for a stranger: all failed polls.
  // Three failures and the pool is left alone — plus the requests already in flight.
  for (const [i, m] of ["500", "html", "404"].entries()) {
    mode = m;
    const before = net.polls.length;
    await at(env, T0 + 300 * (i + 1));
    assert.equal(net.polls.length - before, 8, m);
  }
  assert.equal(net.alerts().length, 0);
  assert.deepEqual(env.DB.rows("SELECT DISTINCT workers, checked_at FROM miners"), [{ workers: '{"a":0}', checked_at: T0 }], "state untouched by failed polls");

  mode = "429";
  let before = net.polls.length;
  await at(env, T0 + 1500);
  assert.equal(net.polls.length - before, 6, "one 429 stops the pool; only the requests already in flight went out");
  mode = "ok";
  before = net.polls.length;
  await at(env, T0 + 1800);
  assert.equal(net.polls.length, before, "and it is given a 10 min rest");

  await at(env, T0 + 2100);
  await at(env, T0 + 2400);
  assert.equal(net.alerts().length, 0, "recovered: every worker was online all along");
  assert.equal(env.DB.one("SELECT COUNT(*) AS n FROM miners WHERE checked_at >= ?", T0 + 2100).n, 20);
});

test("watch: PearlHash lists only connected workers — one that vanishes is pushed 10 min after it was first missed", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  let workers = [{ worker_name: "g1" }, { worker_name: "g2" }];
  net.pool = () => Response.json({ connected_workers: workers });
  await watch(env, tok(1), [{ id: "w1", pool: "PearlHash", addr: addr(1), label: "PH", after: 600 }]);
  await tick(env);
  workers = [{ worker_name: "g1" }];
  await at(env, T0 + 300);
  await at(env, T0 + 600);
  assert.equal(net.alerts().length, 0);
  await at(env, T0 + 900);
  assert.deepEqual(net.alerts().map((c) => c.body.aps.alert), [{ title: "🔴 g2 offline", subtitle: "PH", body: "Offline for 10 min" }]);
  // The whole account gone quiet is every worker offline, not "no such miner".
  workers = [];
  await at(env, T0 + 1200);
  await at(env, T0 + 1800);
  assert.deepEqual(net.alerts().map((c) => c.body.aps.alert.title), ["🔴 g2 offline", "🔴 g1 offline"]);
});

test("watch: the pool saying 'no such miner' is flagged, pushes nothing and keeps the last known state", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  let gone = false;
  net.pool = () => (gone ? new Response("", { status: 404 }) : Response.json({ originData: { workers: [{ name: "r", status: 0, last_share: T0 }], worker_length_all: 1 } }));
  const key = "0123456789abcdef0123456789abcdef";
  await watch(env, tok(1), [{ id: "f2", pool: "F2Pool", addr: key, acct: "my rig", after: 600 }]);
  await tick(env);
  assert.equal(net.polls[0].url, `https://www.f2pool.com/mining-user-prl/${key}?user_name=my%20rig&action=get_pagination_workers&account=my%20rig&currency=PRL`);
  assert.equal(net.polls[0].headers["x-requested-with"], "XMLHttpRequest");
  gone = true;                       // the read-only link was revoked
  for (let i = 1; i <= 4; i++) await at(env, T0 + i * 300);
  assert.equal(net.alerts().length, 0);
  assert.deepEqual(miner(env, `${key}/my rig`, "F2Pool"), { workers: '{"r":0}', tried_at: T0 + 1200, checked_at: T0, missing: 1 });
  assert.deepEqual((await call(env, "GET", `/v1/devices/${tok(1)}`)).body.watches,
                   [{ id: "f2", pool: "F2Pool", after: 600, checked_at: T0, missing: true, stale: false }]);
});

test("watch: quiet hours hold the push until the window opens — and drop it if the worker is back by then", async () => {
  // T0 is 08:00 in Shanghai; the window opens at 09:00.
  const window = { start: 9 * 60, end: 23 * 60, tz: "Asia/Shanghai" };
  for (const recovers of [false, true]) {
    setNow(T0);
    const net = installFetch();
    const env = makeEnv();
    let rigs = [["a", true, T0]];
    net.pool = () => kx(rigs);
    await watch(env, tok(1), [K()], { window });
    await tick(env);
    rigs = [["a", false, T0 + 60]];
    for (let t = 300; t <= 3300; t += 300) await at(env, T0 + t);
    assert.equal(net.alerts().length, 0, "still quiet hours");
    assert.equal(sub(env, tok(1)).told, "{}");
    if (recovers) rigs = [["a", true, T0 + 3590]];
    await at(env, T0 + 3600);
    await at(env, T0 + 3900);
    if (recovers) assert.equal(net.alerts().length, 0);
    else assert.deepEqual(net.alerts().map((c) => c.body.aps.alert.body), ["Offline for 59 min"]);
    restoreNow();
  }
});

test("watch: a push APNs didn't take is tried again at the next poll; a dead token is forgotten", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  let rigs = [["a", true, T0]];
  net.pool = () => kx(rigs);
  await watch(env, tok(1), [K()]);
  await watch(env, tok(2), [K()]);
  await register(env, tok(2), [{ id: "r", kind: "above", value: 99 }]);
  await tick(env);
  rigs = [["a", false, T0 + 10]];
  await at(env, T0 + 300);
  let flaky = true;
  net.apns = (c) => (c.token === tok(1) && flaky ? { status: 503, reason: "ServiceUnavailable" }
                    : c.token === tok(2) ? { status: 410, reason: "Unregistered" } : { status: 200 });
  await at(env, T0 + 660);
  assert.equal(sub(env, tok(1)).told, "{}", "claim taken back");
  // Both verdicts are on record, with what APNs said.
  const kept = JSON.parse(env.DB.one("SELECT v FROM kv WHERE k = ?", `sent:${T0 + 660}`).v);
  assert.deepEqual(kept.pushes.sort((a, b) => (a.tok < b.tok ? -1 : 1)), [
    { tok: tok(1).slice(0, 8), watch: "w1", n: 1, ok: false, status: 503, reason: "ServiceUnavailable", verdict: "retry" },
    { tok: tok(2).slice(0, 8), watch: "w1", n: 1, ok: false, status: null, reason: "Unregistered", verdict: "drop" },
  ]);
  assert.equal(env.DB.one("SELECT COUNT(*) AS n FROM devices WHERE token = ?", tok(2)).n, 0);
  assert.equal(env.DB.one("SELECT COUNT(*) AS n FROM watches WHERE token = ?", tok(2)).n, 0);
  assert.equal(env.DB.one("SELECT COUNT(*) AS n FROM rules WHERE token = ?", tok(2)).n, 0);
  flaky = false;
  const before = net.alerts().length;
  await at(env, T0 + 960);
  assert.deepEqual(net.alerts().slice(before).map((c) => c.token), [tok(1)]);
  await at(env, T0 + 1260);
  assert.equal(net.alerts().length, before + 1);
});

test("watch: each pool has its own cap per tick; the backlog just takes more ticks", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  net.pool = (u) => (u.hostname === "pearlhash.xyz" ? Response.json({ connected_workers: [] }) : kx([]));
  for (let d = 0; d < 2; d++) {
    const ws = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, pool: "PearlHash", addr: addr(d * 20 + i), after: 600 }));
    assert.equal((await watch(env, tok(d), ws)).status, 200);
  }
  await watch(env, tok(9), [K("k", { addr: addr(999) })]);
  await tick(env);
  const hosts = (from) => net.polls.slice(from).reduce((m, p) => (m[new URL(p.url).hostname] = (m[new URL(p.url).hostname] || 0) + 1, m), {});
  assert.deepEqual(hosts(0), { "pearlhash.xyz": 30, "prl-api.kryptex.network": 1 });
  await at(env, T0 + 60);
  assert.deepEqual(hosts(31), { "pearlhash.xyz": 10 });
  await at(env, T0 + 120);
  assert.equal(net.polls.length, 41);
});

test("watch: the pools are still checked on a tick that has no price", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  net.pool = () => kx([["a", true, T0]]);
  await watch(env, tok(1), [K()]);
  const inner = globalThis.fetch;
  globalThis.fetch = (url, init) => (/push\.apple\.com|kryptex/.test(String(url)) ? inner(url, init) : Promise.resolve(new Response("down", { status: 503 })));
  await tick(env);
  assert.equal(env.DB.one("SELECT COUNT(*) AS n FROM prices").n, 0);
  assert.equal(miner(env).checked_at, T0);
});

test("watch: an unnamed PearlHash worker whose IP changes was never offline", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  let workers = [{ ip: "1.2.3.4" }, { ip: "1.2.3.4" }];
  net.pool = () => Response.json({ connected_workers: workers });
  await watch(env, tok(1), [{ id: "w1", pool: "PearlHash", addr: addr(1), after: 600 }]);
  await tick(env);
  workers = [{ ip: "5.6.7.8" }, { ip: "9.9.9.9" }];          // new addresses, same two rigs
  for (let i = 1; i <= 4; i++) await at(env, T0 + i * 300);
  assert.equal(net.alerts().length, 0);
  workers = [{ ip: "5.6.7.8" }];                              // one of them really drops
  for (let i = 5; i <= 7; i++) await at(env, T0 + i * 300);
  assert.deepEqual(net.alerts().map((c) => c.body.aps.alert.title), ["🔴 unnamed (2) offline"]);
});

test("watch: an outage on many monitors at once sends a device a few pushes per tick, the rest at the next poll", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  let rigs = [["a", true, T0]];
  net.pool = () => kx(rigs);
  await watch(env, tok(1), [1, 2, 3, 4, 5].map((i) => K(`w${i}`, { addr: addr(i), label: `Site ${i}` })));
  await watch(env, tok(2), [K("x", { addr: addr(1) })]);
  await tick(env);
  rigs = [["a", false, T0 + 10]];
  await at(env, T0 + 300);
  await at(env, T0 + 660);
  const to = (token) => net.alerts().filter((c) => c.token === token).length;
  assert.equal(to(tok(1)), 3);
  assert.equal(to(tok(2)), 1, "another device is not held back by it");
  await at(env, T0 + 960);
  assert.equal(to(tok(1)), 5, "the held-back monitors follow at their next poll");
  await at(env, T0 + 1260);
  assert.equal(net.alerts().length, 6);
});

test("watch: a pool that is resting or backed up never takes another pool's turn", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  let limited = true;
  net.pool = (u) => (u.hostname === "pearlhash.xyz"
    ? (limited ? new Response("{}", { status: 429 }) : Response.json({ connected_workers: [] }))
    : kx([["a", true, T0]]));
  for (let d = 0; d < 3; d++) {
    await watch(env, tok(d), Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, pool: "PearlHash", addr: addr(d * 20 + i), after: 600 })));
  }
  await watch(env, tok(9), [K("k", { addr: addr(999) })]);
  const kryptex = () => net.polls.filter((p) => p.url.includes("kryptex")).length;
  await tick(env);                    // PearlHash answers 429 and is rested; 60 of its miners stay overdue
  assert.equal(kryptex(), 1);
  const before = net.polls.length;
  await at(env, T0 + 300);
  assert.equal(kryptex(), 2, "Kryptex is polled on time behind PearlHash's backlog");
  assert.equal(net.polls.length - before, 1, "and PearlHash is left alone while it rests");
  limited = false;
  await at(env, T0 + 600);
  assert.equal(net.polls.filter((p) => p.url.includes("pearlhash")).length > 6, true);
});

test("watch: the app is told when the pool hasn't answered for a monitor", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  let up = false;
  net.pool = () => (up ? kx([["a", true, T0]]) : new Response("<html>blocked</html>", { status: 403 }));
  const stale = async () => (await call(env, "GET", `/v1/devices/${tok(1)}`)).body.watches[0].stale;
  await watch(env, tok(1), [K()]);
  assert.equal(await stale(), false, "not polled yet");
  await tick(env);
  assert.equal(await stale(), true, "tried, never answered");
  up = true;
  await at(env, T0 + 300);
  assert.equal(await stale(), false);
  up = false;
  await at(env, T0 + 600);
  await at(env, T0 + 1800);
  assert.equal(await stale(), false, "25 min since the last answer: a blip");
  await at(env, T0 + 2400);
  assert.equal(await stale(), true, "35 min without an answer");
});

test("prune: a device with watches is kept while APNs still knows it, however long the app stays closed", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  net.pool = () => kx([["a", true, T0]]);
  await watch(env, tok(1), [K()]);                                   // stays installed
  await watch(env, tok(2), [K("w2", { addr: addr(2) })]);            // gets uninstalled
  await register(env, tok(3), [{ id: "r", kind: "above", value: 99 }]);   // price alerts only
  const day = 86400;
  const silent = () => net.calls.filter((c) => c.headers["apns-push-type"] === "background").map((c) => c.token);
  const registered = silent().length;

  await at(env, T0 + 29 * day);
  assert.equal(silent().length, registered, "nothing to check before 30 days");
  net.apns = (c) => (c.token === tok(2) ? { status: 410, reason: "Unregistered" } : { status: 200 });
  await at(env, T0 + 31 * day);
  assert.deepEqual(silent().slice(registered).sort(), [tok(1), tok(2)]);
  assert.equal(env.DB.one("SELECT seen_at FROM devices WHERE token = ?", tok(1)).seen_at, T0 + 31 * day);
  assert.equal(env.DB.one("SELECT COUNT(*) AS n FROM watches WHERE token = ?", tok(2)).n, 0, "the dead token and its watches are gone");

  for (const d of [62, 93, 124, 200]) await at(env, T0 + d * day);
  assert.equal(env.DB.one("SELECT COUNT(*) AS n FROM watches WHERE token = ?", tok(1)).n, 1, "200 days without opening the app");
  assert.equal(env.DB.one("SELECT COUNT(*) AS n FROM devices WHERE token = ?", tok(3)).n, 0, "price-only devices still go after 90 days");
  assert.equal(net.alerts().length, 0);
});

test("watch: a device that goes away takes the miners only it watched with it, at once", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  net.pool = () => kx([["a", true, T0]]);
  await watch(env, tok(1), [K("mine", { addr: addr(1) }), K("shared", { addr: addr(2) })]);
  await watch(env, tok(2), [K("shared", { addr: addr(2) })]);
  await tick(env);
  assert.equal(env.DB.one("SELECT COUNT(*) AS n FROM miners").n, 2);
  assert.equal((await call(env, "DELETE", `/v1/devices/${tok(1)}`)).status, 200);
  assert.deepEqual(env.DB.rows("SELECT addr FROM miners"), [{ addr: addr(2) }], "the one tok(2) still watches stays");
  const before = net.polls.length;
  await at(env, T0 + 300);
  assert.deepEqual(net.polls.slice(before).map((p) => p.url.split("/").pop()), [addr(2)], "and the other is no longer polled");
});

test("watch: a pool answer larger than the cap is a failed poll, cut off while it is being read", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  let pulled = 0;
  net.pool = () => new Response(new ReadableStream({
    pull(c) {                     // an endless body: only a reader that stops can get past it
      pulled++;
      c.enqueue(new Uint8Array(256 * 1024).fill(32));
    },
  }));
  await watch(env, tok(1), [K()]);
  await tick(env);
  assert.deepEqual(miner(env), { workers: "{}", tried_at: T0, checked_at: null, missing: 0 });
  assert.ok(pulled < 20, `stopped after ${pulled} chunks`);
});

test("watch: tokens APNs has never accepted share a small budget of offline pushes per tick", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  let rigs = [["a", true, T0]];
  net.pool = () => kx(rigs);
  net.apns = () => ({ status: 503, reason: "ServiceUnavailable" });      // APNs is down while they register: admitted unproven
  for (let i = 0; i < 25; i++) assert.equal((await watch(env, tok(i), [K()])).status, 200);
  assert.equal(env.DB.one("SELECT COUNT(*) AS n FROM devices WHERE verified_at IS NULL").n, 25);
  net.apns = () => ({ status: 200 });
  await tick(env);
  rigs = [["a", false, T0 + 10]];
  await at(env, T0 + 300);
  await at(env, T0 + 660);
  assert.equal(net.alerts().length, 20);
  await at(env, T0 + 960);
  assert.equal(net.alerts().length, 25, "the rest at the next poll");
});

// ── routes ───────────────────────────────────────────────────────────────────

test("routes: PUT watches validates everything it stores", async () => {
  setNow(T0);
  installFetch();
  const env = makeEnv();
  const bad = async (watches, extra) => (await watch(env, tok(1), watches, extra)).status;
  assert.equal(await bad("nope"), 400);
  assert.equal(await bad([K(), K()]), 400, "duplicate ids");
  assert.equal(await bad([K("w1", { pool: "TW-Pool" })]), 400);
  assert.equal(await bad([K("w1", { addr: "https://evil.example/" })]), 400);
  assert.equal(await bad(Array.from({ length: 21 }, (_, i) => K(`w${i}`, { addr: addr(i) }))), 400);
  assert.equal(await bad([K()], { topic: "com.evil" }), 400);
  assert.equal(await bad([K()], { env: "staging" }), 400);
  assert.equal(await bad({ w1: K() }), 400, "a list, or nothing");
  assert.equal(env.DB.one("SELECT COUNT(*) AS n FROM devices").n, 0);
  assert.equal(env.DB.one("SELECT COUNT(*) AS n FROM miners").n, 0);
  // The watches ride on the device record: there is no endpoint of their own.
  assert.equal((await call(env, "PUT", `/v1/devices/${tok(1)}/watches`, {})).status, 404);
});

test("routes: watches always need the signed Pro purchase, and a token APNs knows", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  // No purchase: refused even while REQUIRE_PRO is off (that exemption is for apps older than this endpoint).
  assert.deepEqual(await H.watch(env, tok(1), [K()]), { status: 403, body: { error: "not pro" } });
  const forged = await signJWS(await makeChain(), proTx());
  assert.equal((await H.watch(env, tok(1), [K()], { pro_jws: forged })).status, 403);
  const refunded = await signJWS(chain, proTx({ revocationDate: Date.UTC(2026, 8, 2) }));
  assert.equal((await H.watch(env, tok(1), [K()], { pro_jws: refunded })).status, 403);
  // Xcode's local StoreKit signature — which anyone can write by hand — is let through
  // for price alerts in development, never for watches: with a self-signed chain…
  const xcode = await signJWS(await makeChain(), proTx({ environment: "Xcode" }));
  assert.equal((await H.watch(env, tok(1), [K()], { pro_jws: xcode })).status, 403);
  // …or with no real signature at all.
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const handmade = `${b64({ alg: "ES256" })}.${b64({ environment: "Xcode" })}.AAAA`;
  assert.equal((await H.watch(env, tok(1), [K()], { pro_jws: handmade })).status, 403);
  assert.equal((await H.watch(env, tok(1), [], { pro_jws: xcode, rules: [{ id: "r", kind: "above", value: 9 }] })).status, 200,
               "the development exemption still covers price alerts");
  assert.equal(env.DB.one("SELECT COUNT(*) AS n FROM watches").n + env.DB.one("SELECT COUNT(*) AS n FROM miners").n, 0);
  await call(env, "DELETE", `/v1/devices/${tok(1)}`);
  assert.equal(env.DB.one("SELECT COUNT(*) AS n FROM devices").n, 0);
  assert.equal((await H.watch(env, tok(1), [])).status, 200, "an empty list needs nothing");

  assert.equal((await watch(env, tok(1), [K()])).status, 200);
  assert.equal(env.DB.one("SELECT original_transaction_id AS otid FROM devices").otid, "1000001");
  // A refund of that purchase takes the watches with it.
  const refund = await signJWS(chain, { notificationType: "REFUND", notificationUUID: "u-1", data: {
    bundleId: "com.prl.wizard", environment: "Production", signedTransactionInfo: await signJWS(chain, proTx()) } });
  assert.equal((await call(env, "POST", "/v1/asn/asn-secret", { signedPayload: refund })).status, 200);
  assert.equal(env.DB.one("SELECT COUNT(*) AS n FROM watches").n, 0);

  const open = makeEnv();
  net.apns = () => ({ status: 400, reason: "BadDeviceToken" });
  assert.deepEqual(await watch(open, tok(1), [K()]), { status: 400, body: { error: "bad token" } });
  assert.equal(open.DB.one("SELECT COUNT(*) AS n FROM watches").n, 0);
});

test("routes: the request the app builds (the sample its own tests check) is taken whole", async () => {
  setNow(T0);
  installFetch();
  const env = makeEnv();
  const body = JSON.parse(fx("alerts_put_body.json"));
  body.pro_jws = PRO;
  const res = await call(env, "PUT", `/v1/devices/${tok(1)}`, body);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.rules.map((r) => [r.id, r.kind, r.value, r.window, r.enabled]), [
    ["A1B2C3D4-0000-4000-8000-000000000001", "above", 1.2, 0, true],
    ["A1B2C3D4-0000-4000-8000-000000000002", "move", 5, 3600, false],
  ]);
  assert.deepEqual(env.DB.rows("SELECT id, pool, addr, label, after, again FROM watches ORDER BY rowid"), [
    { id: "6F1B7C2A-1111-4C1C-9C43-000000000001", pool: "Kryptex", addr: "prl1p8wznc8tkhlkjaq7v8ycugz93rgs8uezq6px7873934kh35nk9q2qlz0q9m", label: "Garage", after: 900, again: 3600 },
    { id: "6F1B7C2A-1111-4C1C-9C43-000000000002", pool: "F2Pool", addr: "0123456789abcdef0123456789abcdef/My Rig", label: "F2Pool", after: 3600, again: 0 },
  ]);
  assert.deepEqual(env.DB.one("SELECT lang, oneshot, win_start, win_end, tz, original_transaction_id AS otid FROM devices"),
                   { lang: "zh-Hans", oneshot: 1, win_start: 480, win_end: 1380, tz: "Asia/Shanghai", otid: "1000001" });
});

test("routes: watches and price alerts are one device record; it goes when both are gone", async () => {
  setNow(T0);
  installFetch();
  const env = makeEnv();
  const count = (table) => env.DB.one(`SELECT COUNT(*) AS n FROM ${table} WHERE token = ?`, tok(1)).n;
  const rule = { id: "r", kind: "above", value: 99 };
  const zone = { start: 480, end: 1380, tz: "Asia/Shanghai" };

  // One PUT carries both lists and the settings they share.
  const both = await watch(env, tok(1), [K()], { rules: [rule], lang: "zh-Hans", window: zone });
  assert.equal(both.status, 200);
  assert.deepEqual([both.body.rules.map((r) => r.id), both.body.watches.map((w) => w.id)], [["r"], ["w1"]]);
  assert.deepEqual(env.DB.one("SELECT lang, oneshot, win_start, tz FROM devices WHERE token = ?", tok(1)),
                   { lang: "zh-Hans", oneshot: 1, win_start: 480, tz: "Asia/Shanghai" });
  const got = (await call(env, "GET", `/v1/devices/${tok(1)}`)).body;
  assert.deepEqual([got.rules.length, got.watches.length], [1, 1]);

  await watch(env, tok(1), [K()]);                      // the last price alert removed
  assert.deepEqual([count("devices"), count("rules"), count("watches")], [1, 0, 1]);
  await watch(env, tok(1), [], { rules: [rule] });      // the last watch removed
  assert.deepEqual([count("devices"), count("rules"), count("watches")], [1, 1, 0]);
  assert.deepEqual((await watch(env, tok(1), [])).body, { ok: true, rules: [], watches: [] });
  assert.equal(count("devices"), 0);

  await watch(env, tok(1), [K()], { rules: [rule] });
  assert.equal((await call(env, "DELETE", `/v1/devices/${tok(1)}`)).status, 200);
  assert.deepEqual([count("devices"), count("rules"), count("watches")], [0, 0, 0]);
});

test("routes: an app that doesn't know watches (1.19 and earlier) leaves them alone", async () => {
  setNow(T0);
  installFetch();
  const env = makeEnv();
  const count = (table) => env.DB.one(`SELECT COUNT(*) AS n FROM ${table} WHERE token = ?`, tok(1)).n;
  const rule = { id: "r", kind: "above", value: 99 };
  await watch(env, tok(1), [K()], { rules: [rule] });
  // The same token from an older build: rules only, no `watches` key at all.
  const old = await register(env, tok(1), [{ ...rule, value: 5 }]);
  assert.deepEqual([old.status, count("watches")], [200, 1]);
  assert.deepEqual(await register(env, tok(1), []), { status: 200, body: { ok: true, rules: [] } });
  assert.deepEqual([count("devices"), count("rules"), count("watches")], [1, 0, 1], "its 'no alerts left' keeps the device that still has watches");
  // …and rules sent without a purchase stay possible for it; watches never are.
  assert.equal((await H.watch(env, tok(2), [], { rules: [rule] })).status, 200);
  assert.equal((await H.watch(env, tok(3), [K()], { rules: [rule] })).status, 403);
  assert.equal(env.DB.one("SELECT COUNT(*) AS n FROM rules WHERE token = ?", tok(3)).n, 0);
});

test("routes: re-sending a watch keeps what it was told; pointing it elsewhere starts over", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  net.pool = () => kx([["a", true, T0]]);
  await watch(env, tok(1), [K(), K("w2", { addr: addr(2) })]);
  await tick(env);
  env.DB.raw.prepare("UPDATE watches SET told = ? WHERE id = 'w1'").run('{"a":[5,6]}');
  await watch(env, tok(1), [K("w1", { label: "Renamed", after: 3600 })]);
  assert.deepEqual(env.DB.rows("SELECT id, label, after, told, base FROM watches"),
                   [{ id: "w1", label: "Renamed", after: 3600, told: '{"a":[5,6]}', base: 1 }]);
  await watch(env, tok(1), [K("w1", { addr: addr(3) })]);
  assert.deepEqual(env.DB.rows("SELECT addr, told, base FROM watches"), [{ addr: addr(3), told: "{}", base: 0 }]);
  // Miners nobody watches any more stop being polled at once: rewriting the list
  // over and over can't pile up a queue.
  assert.deepEqual(env.DB.rows("SELECT addr FROM miners"), [{ addr: addr(3) }]);
  await watch(env, tok(1), []);
  assert.equal(env.DB.one("SELECT COUNT(*) AS n FROM miners").n, 0);
});

test("watch: still offline `again` after the push — one reminder; its return is still announced", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  let rigs = [["a", true, T0]];
  net.pool = () => kx(rigs);
  await watch(env, tok(1), [K("w1", { again: 1800 })]);
  await tick(env);
  rigs = [["a", false, T0 + 60]];
  for (let t = T0 + 180; t <= T0 + 720; t += 180) await at(env, t);
  assert.equal(net.alerts().length, 1);
  assert.equal(net.alerts()[0].body.aps.alert.title, "🔴 a offline");
  assert.equal(sub(env, tok(1)).told, JSON.stringify({ a: [T0 + 60, T0 + 720] }));
  for (let t = T0 + 900; t < T0 + 720 + 1800; t += 180) await at(env, t);
  assert.equal(net.alerts().length, 1, "not before 30 min after the push");
  await at(env, T0 + 2520);
  assert.equal(net.alerts().length, 2);
  assert.deepEqual(net.alerts()[1].body.aps.alert, { title: "🔴 a still offline", subtitle: "Kryptex", body: "Offline for 41 min" });
  assert.deepEqual(net.alerts()[1].body.watch, { id: "w1", n: 1, still: true });
  assert.equal(sub(env, tok(1)).told, JSON.stringify({ a: [T0 + 60, T0 + 720, 0, 0, T0 + 2520] }));
  assert.deepEqual(JSON.parse(env.DB.one("SELECT v FROM kv WHERE k = ?", `sent:${T0 + 2520}`).v).pushes[0],
                   { tok: tok(1).slice(0, 8), watch: "w1", n: 1, still: true, ok: true, env: "production" });
  for (let t = T0 + 2700; t <= T0 + 9000; t += 180) await at(env, t);
  assert.equal(net.alerts().length, 2, "a reminder is said once");
  rigs = [["a", true, T0 + 9100]];
  await at(env, T0 + 9180);
  await at(env, T0 + 9240);
  assert.equal(net.alerts().length, 3);
  assert.equal(net.alerts()[2].body.aps.alert.title, "🟢 a back online");
});

test("watch: switching the reminder on mid-outage doesn't ring about it; the next outage gets one", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  let rigs = [["a", true, T0]];
  net.pool = () => kx(rigs);
  await watch(env, tok(1), [K()]);
  await tick(env);
  rigs = [["a", false, T0 + 60]];
  for (let t = T0 + 180; t <= T0 + 900; t += 180) await at(env, t);
  assert.equal(net.alerts().length, 1);
  setNow(T0 + 1000);
  await watch(env, tok(1), [K("w1", { again: 1800 })]);
  for (let t = T0 + 1080; t <= T0 + 6000; t += 180) await at(env, t);
  assert.equal(net.alerts().length, 1, "that outage was already known");
  // Back, told so; past the cool-down it drops again: this one is reminded about.
  rigs = [["a", true, T0 + 6100]];
  await at(env, T0 + 6120);
  await at(env, T0 + 6180);
  assert.equal(net.alerts().length, 2);
  rigs = [["a", false, T0 + 6200]];
  for (let t = T0 + 6300; t <= T0 + 7000; t += 180) await at(env, t);
  assert.equal(net.alerts().length, 3);
  const pushedAt = JSON.parse(sub(env, tok(1)).told).a[1];
  for (let t = T0 + 7020; t <= pushedAt + 1800 + 180; t += 180) await at(env, t);
  assert.equal(net.alerts().length, 4);
  assert.equal(net.alerts()[3].body.aps.alert.title, "🔴 a still offline");
});

test("routes: the reminder is stored per watch, and dated from when it was switched on", async () => {
  setNow(T0);
  installFetch();
  const env = makeEnv();
  const row = () => env.DB.one("SELECT after, again, again_at FROM watches WHERE id = 'w1'");
  await watch(env, tok(1), [K("w1", { after: 7200 })]);
  assert.deepEqual(row(), { after: 7200, again: 0, again_at: T0 });
  setNow(T0 + 100);
  await watch(env, tok(1), [K("w1", { after: 7200, again: 3600 })]);
  assert.deepEqual(row(), { after: 7200, again: 3600, again_at: T0 + 100 });
  setNow(T0 + 200);
  await watch(env, tok(1), [K("w1", { after: 7200, again: 14400 })]);
  assert.deepEqual(row(), { after: 7200, again: 14400, again_at: T0 + 100 }, "another delay is the same reminder");
  setNow(T0 + 300);
  await watch(env, tok(1), [K("w1", { after: 7200 })]);
  setNow(T0 + 400);
  await watch(env, tok(1), [K("w1", { after: 7200, again: 1800 })]);
  assert.deepEqual(row(), { after: 7200, again: 1800, again_at: T0 + 400 }, "off and on again starts afresh");
});
