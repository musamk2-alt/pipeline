import { db, initDbOnce } from "../_db.js";

export default async function handler(req, res) {
  try {
    await initDbOnce();
    const pool = db();
    const raw = await pool.query(`select count(*)::int as c from raw_events`);
    const buys = await pool.query(`select count(*)::int as c from buy_events`);
    const latest = await pool.query(
      `select signature, block_time from raw_events order by created_at desc limit 10`
    );

    res.json({ rawCount: raw.rows[0].c, buyCount: buys.rows[0].c, latest: latest.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
