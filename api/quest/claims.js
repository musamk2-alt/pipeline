import { db, initDbOnce } from "../_db.js";
import { nowHourIndex } from "../_quests.js";

export default async function handler(req, res) {
  try {
    await initDbOnce();
    const pool = db();
    const hourIndex = nowHourIndex();

    const q = await pool.query(
      `select wallet, signature, badge, created_at
       from quest_claims
       where hour_index=$1
       order by created_at asc
       limit 50`,
      [hourIndex]
    );

    res.json({ ok: true, claims: q.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
