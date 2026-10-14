// Loopback-only Blockbook fixture for payment UI QA. Never used in production.
// POST /payment { sats, confirmations } simulates an inbound transfer.
import http from "node:http";
const txs = [];
http
  .createServer(async (req, res) => {
    const send = (o, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (req.method === "POST" && req.url === "/payment") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const o = JSON.parse(Buffer.concat(chunks).toString());
      if (!Number.isSafeInteger(o.sats) || o.sats <= 0)
        return send({ error: "amount" }, 400);
      const txid = "f".repeat(64);
      const tx = {
        txid,
        confirmations: o.confirmations || 0,
        blockTime: Math.floor(Date.now() / 1000),
        vin: [{ addresses: ["sender"], value: String(o.sats + 100) }],
        vout: [{ addresses: ["prl1" + "z".repeat(38)], value: String(o.sats) }],
      };
      const i = txs.findIndex((t) => t.txid === txid);
      if (i < 0) txs.push(tx);
      else txs[i] = tx;
      return send({ ok: true });
    }
    const u = new URL(req.url, "http://localhost");
    if (u.pathname.startsWith("/api/v2/address/"))
      return send({
        balance: "200000000",
        unconfirmedBalance: "0",
        txs: txs.length,
        transactions: txs,
        totalPages: 1,
      });
    return send({ error: "not found" }, 404);
  })
  .listen(8899, "127.0.0.1", () =>
    console.log("Local Blockbook fixture: http://127.0.0.1:8899"),
  );
