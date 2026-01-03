import express from "express";
import cors from "cors";
import { z } from "zod";
import { Pool } from "pg";
import "dotenv/config";


const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ===== CONFIG =====
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "dev-secret-change-me";
const CREATOR_WALLET =
  process.env.CREATOR_WALLET || "6XiPyaiogYybJZUiryTR216io3YNrLfz1QhFPrELGWuA";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL missing. Set it in your environment variables.");
}

// Supabase typically requires SSL from cloud hosts.
// rejectUnauthorized:false avoids CA issues in some environments.
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const WebhookSchema = z.array(z.any());

// ===== DB INIT =====
async function initDb() {
  await pool.query(`
    create table if not exists raw_events (
      id bigserial primary key,
      signature text not null unique,
      block_time bigint not null,
      payload jsonb not null
    );
  `);

  await pool.query(`
    create table if not exists buys (
      id bigserial primary key,
      signature text not null,
      buyer_wallet text not null,
      block_time bigint not null,
      mint text not null,
      token_amount numeric not null,
      sol_spent numeric,
      source text default 'unknown',
      unique(signature, buyer_wallet)
    );
  `);

  await pool.query(`
    create table if not exists wallet_stats (
      wallet text not null,
      mint text not null,
      total_bought numeric not null default 0,
      buy_count int not null default 0,
      first_buy_time timestamptz,
      last_buy_time timestamptz,
      primary key(wallet, mint)
    );
  `);
}

// ===== DB HELPERS =====
async function insertRawEvent(signature, blockTimeSeconds, payloadObj) {
  await pool.query(
    `insert into raw_events(signature, block_time, payload)
     values($1, $2, $3)
     on conflict (signature) do nothing`,
    [signature, BigInt(blockTimeSeconds), payloadObj]
  );
}

async function getStats() {
  const raw = await pool.query(`select count(*)::int as c from raw_events`);
  const buy = await pool.query(`select count(*)::int as c from buys`);
  return { rawCount: raw.rows[0].c, buyCount: buy.rows[0].c };
}

// ===== ROUTES =====

// health
app.get("/health", async (req, res) => {
  try {
    const stats = await getStats();
    res.json({ ok: true, stats, creator: CREATOR_WALLET });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

// debug: latest raw events
app.get("/debug/top-mints", async (req, res) => {
  try {
    const r = await pool.query(`
      select payload
      from raw_events
      order by block_time desc
      limit 200
    `);

    const counts = new Map();

    for (const row of r.rows) {
      const p = row.payload;

      const tokenTransfers = p?.tokenTransfers || [];
      for (const t of tokenTransfers) {
        const mint = t?.mint;
        if (!mint) continue;
        counts.set(mint, (counts.get(mint) || 0) + 1);
      }

      const changes = p?.accountData?.tokenBalanceChanges || [];
      for (const c of changes) {
        const mint = c?.mint;
        if (!mint) continue;
        counts.set(mint, (counts.get(mint) || 0) + 1);
      }
    }

    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([mint, count]) => ({ mint, count }));

    res.json({ ok: true, top });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});


app.get("/debug/raw", async (req, res) => {
  try {
    const stats = await getStats();
    const latest = await pool.query(
      `select signature, block_time
       from raw_events
       order by block_time desc
       limit 10`
    );

    res.json({
      ...stats,
      latest: latest.rows.map((r) => ({
        signature: r.signature,
        block_time: Number(r.block_time),
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

// webhook receiver (Helius -> us)
app.post("/webhook/helius", async (req, res) => {
  try {
    const auth = req.header("authorization") || "";
    if (auth !== `Bearer ${WEBHOOK_SECRET}`) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const parsed = WebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: "expected array payload" });
    }

    const txs = parsed.data;

    // Insert all events
    for (const tx of txs) {
      const sig = tx.signature ?? tx.transaction?.signatures?.[0];
      const ts = tx.timestamp ? Number(tx.timestamp) : Math.floor(Date.now() / 1000);
      if (!sig) continue;

      await insertRawEvent(sig, ts, tx);
    }

    res.json({ ok: true, inserted: txs.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

// ===== START =====
const PORT = process.env.PORT || 3001;

(async () => {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`CREATOR_WALLET: ${CREATOR_WALLET}`);
  });
})();
