import { db, initDbOnce } from "../_db.js";

export default async function handler(req, res) {
  try {
    await initDbOnce();
    const pool = db();
    const q = await pool.query(`select mint, count from mint_counter order by count desc, mint asc limit 10`);
    res.json({ ok: true, top: q.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
