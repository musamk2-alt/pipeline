import { db, initDbOnce } from "../_db.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method not allowed" });

    const secret = process.env.WEBHOOK_SECRET || "dev-secret-change-me";
    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${secret}`) return res.status(401).json({ ok: false, error: "unauthorized" });

    await initDbOnce();
    const pool = db();

    const events = Array.isArray(req.body) ? req.body : [];
    let inserted = 0;

    for (const ev of events) {
      const signature = String(ev?.signature || ev?.transactionSignature || "").trim();
      if (!signature) continue;

      const blockTime = ev?.timestamp || ev?.blockTime || ev?.block_time || null;

      const r = await pool.query(
        `insert into raw_events(signature, block_time, payload)
         values($1,$2,$3)
         on conflict(signature) do nothing`,
        [signature, blockTime, ev]
      );
      if (r.rowCount) inserted++;

      const mint = ev?.mint || ev?.tokenMint || ev?.token?.mint || null;
      if (mint) {
        await pool.query(
          `insert into mint_counter(mint, count, updated_at)
           values($1,1,now())
           on conflict(mint) do update set count=mint_counter.count+1, updated_at=now()`,
          [String(mint)]
        );
      }
    }

    res.json({ ok: true, inserted });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
