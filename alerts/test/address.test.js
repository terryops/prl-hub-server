import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { address } from "../src/chain.js";
const original = fetch;
afterEach(() => { globalThis.fetch = original; });
test("watch address pages retain principal, fee and peer separately", async () => {
  const addr = "prl1" + "a".repeat(38), peer = "prl1" + "b".repeat(38); let requested;
  globalThis.fetch = async (url) => {
    requested = new URL(url);
    return Response.json({ balance: "90000000", unconfirmedBalance: "0", totalPages: 3, txs: 45, transactions: [{ txid: "ab".repeat(32), fees: "1000000", vin: [{ addresses: [addr], value: "100000000" }], vout: [{ addresses: [addr], value: "90000000" }, { addresses: [peer], value: "9000000" }] }] });
  };
  const response = await address({}, { addr, page: 2 }, {}), body = await response.json();
  assert.equal(response.status, 200); assert.equal(requested.searchParams.get("page"), "2");
  assert.equal(body.page, 2); assert.equal(body.hasMore, true);
  assert.equal(body.history[0].amount, "9000000"); assert.equal(body.history[0].fee, "1000000"); assert.equal(body.history[0].delta, "-10000000"); assert.equal(body.history[0].address, peer);
  assert.equal((await address({}, { addr, page: -1 }, {})).status, 400);
});
