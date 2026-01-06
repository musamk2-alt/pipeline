import { db, initDbOnce } from "../_db.js";

export default async function handler(req, res) {
  try {
    await initDbOnce();
    const pool = db();

    const q = await pool.query(
      `select m.wallet, m.codename, m.vibe, m.interactions,
              (select count(*)::int from wallet_badges b where b.wallet=m.wallet) as badge_count
       from wallet_memory m
       order by m.interactions desc, m.updated_at desc
       limit 50`
    );

    res.json({ ok: true, actors: q.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
