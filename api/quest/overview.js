import { db, initDbOnce } from "../_db.js";
import { nowHourIndex, msToNextHour, activeQuestForHour, nextQuests, QUEST_POOL } from "../_quests.js";

export default async function handler(req, res) {
  try {
    await initDbOnce();
    const pool = db();

    const hourIndex = nowHourIndex();
    const active = activeQuestForHour(hourIndex);

    const claims = await pool.query(`select count(*)::int as c from quest_claims where hour_index=$1`, [hourIndex]);

    res.json({
      ok: true,
      active: { ...active, claims: claims.rows[0].c, msLeft: msToNextHour() },
      next: nextQuests(hourIndex, 3),
      pool: QUEST_POOL
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
