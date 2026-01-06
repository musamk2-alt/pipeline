import { db, initDbOnce } from "../_db.js";
import { nowHourIndex, activeQuestForHour } from "../_quests.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method not allowed" });

    const wallet = String(req.body.wallet || "").trim();
    const signature = String(req.body.signature || "").trim();
    if (!wallet || !signature) return res.status(400).json({ ok: false, error: "wallet+signature required" });

    await initDbOnce();
    const pool = db();

    const sig = await pool.query(`select 1 from raw_events where signature=$1`, [signature]);
    if (!sig.rowCount) return res.status(400).json({ ok: false, error: "signature not found in raw_events yet" });

    const hourIndex = nowHourIndex();
    const active = activeQuestForHour(hourIndex);

    await pool.query(
      `insert into quest_claims(hour_index, wallet, signature, badge)
       values($1,$2,$3,$4)
       on conflict (hour_index, wallet) do nothing`,
      [hourIndex, wallet, signature, active.badge]
    );

    await pool.query(
      `insert into wallet_badges(wallet, badge, signature)
       values($1,$2,$3)
       on conflict(wallet, badge) do nothing`,
      [wallet, active.badge, signature]
    );

    await pool.query(
      `insert into wallet_memory(wallet, interactions, updated_at)
       values($1, 1, now())
       on conflict(wallet)
       do update set interactions = wallet_memory.interactions + 1,
                    updated_at = now()`,
      [wallet]
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
