import { db, initDbOnce } from "../../_db.js";

export default async function handler(req, res) {
  try {
    await initDbOnce();
    const pool = db();

    const wallet = String(req.query.wallet || "").trim();

    const mem = await pool.query(`select * from wallet_memory where wallet=$1`, [wallet]);
    const badges = await pool.query(
      `select badge, signature, created_at from wallet_badges where wallet=$1 order by created_at desc limit 20`,
      [wallet]
    );
    const events = await pool.query(
      `select kind, amount, other_wallet, mint, signature, block_time
       from wallet_events
       where wallet=$1
       order by created_at desc
       limit 40`,
      [wallet]
    );

    res.json({
      ok: true,
      wallet: mem.rows[0] || { wallet, vibe: "neutral", interactions: 0 },
      badges: badges.rows,
      events: events.rows
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
