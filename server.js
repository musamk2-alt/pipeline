import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { Pool } from "pg";

const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));

// =====================
// CONFIG
// =====================
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || "").trim();
const CREATOR_WALLET =
  process.env.CREATOR_WALLET || "6XiPyaiogYybJZUiryTR216io3YNrLfz1QhFPrELGWuA";

// OPTIONAL: later set when mint exists
const TARGET_MINT = (process.env.TARGET_MINT || "").trim();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL missing. Set it in env vars.");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const WebhookSchema = z.array(z.any());

// Resolve /public folder for static hosting
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

// =====================
// DB INIT
// =====================
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

// =====================
// AUTH
// =====================
function normalizeAuthHeader(val) {
  if (!val) return "";
  return String(val).trim().replace(/\s+/g, " ");
}

function isAuthorized(req) {
  if (!WEBHOOK_SECRET) return false;

  const raw = normalizeAuthHeader(req.header("authorization"));

  const expectedBearer = `Bearer ${WEBHOOK_SECRET}`;
  const expectedWithPrefix = `Authorization: Bearer ${WEBHOOK_SECRET}`;

  if (raw === expectedBearer) return true;
  if (raw === expectedWithPrefix) return true;
  if (raw.toLowerCase() === expectedBearer.toLowerCase()) return true;
  if (raw.toLowerCase() === expectedWithPrefix.toLowerCase()) return true;

  return false;
}

// =====================
// DB HELPERS
// =====================
async function insertRawEvent(signature, blockTimeSeconds, payloadObj) {
  await pool.query(
    `insert into raw_events(signature, block_time, payload)
     values($1,$2,$3)
     on conflict (signature) do nothing`,
    [signature, BigInt(blockTimeSeconds), payloadObj]
  );
}

async function getStats() {
  const raw = await pool.query(`select count(*)::int as c from raw_events`);
  const buy = await pool.query(`select count(*)::int as c from buys`);
  return { rawCount: raw.rows[0].c, buyCount: buy.rows[0].c };
}

async function insertBuy({ signature, buyer, blockTime, mint, tokenAmount, solSpent, source }) {
  await pool.query(
    `insert into buys(signature, buyer_wallet, block_time, mint, token_amount, sol_spent, source)
     values($1,$2,$3,$4,$5,$6,$7)
     on conflict (signature, buyer_wallet) do nothing`,
    [signature, buyer, BigInt(blockTime), mint, tokenAmount, solSpent ?? null, source ?? "unknown"]
  );

  await pool.query(
    `insert into wallet_stats(wallet, mint, total_bought, buy_count, first_buy_time, last_buy_time)
     values($1,$2,$3,1, to_timestamp($4), to_timestamp($4))
     on conflict (wallet, mint) do update set
       total_bought = wallet_stats.total_bought + excluded.total_bought,
       buy_count = wallet_stats.buy_count + 1,
       last_buy_time = excluded.last_buy_time`,
    [buyer, mint, tokenAmount, Number(blockTime)]
  );
}

// =====================
// PARSERS
// =====================
function extractMintsFromPayload(p) {
  const mints = [];

  const tokenTransfers = p?.tokenTransfers || [];
  for (const t of tokenTransfers) if (t?.mint) mints.push(t.mint);

  const changes = p?.accountData?.tokenBalanceChanges || [];
  for (const c of changes) if (c?.mint) mints.push(c.mint);

  return mints;
}

async function parseBuysForTargetMint({ tx, signature, ts }) {
  if (!TARGET_MINT) return;

  const tokenTransfers = tx?.tokenTransfers || [];
  const nativeTransfers = tx?.nativeTransfers || [];

  const mintTransfers = tokenTransfers.filter((t) => t?.mint === TARGET_MINT);

  for (const t of mintTransfers) {
    const buyer = t?.toUserAccount;
    const amt = Number(t?.tokenAmount ?? 0);
    if (!buyer || !Number.isFinite(amt) || amt <= 0) continue;

    let solSpent = null;
    if (Array.isArray(nativeTransfers) && nativeTransfers.length > 0) {
      const lamportsOut = nativeTransfers
        .filter((n) => n?.fromUserAccount === buyer && typeof n?.amount === "number")
        .reduce((sum, n) => sum + n.amount, 0);

      if (lamportsOut > 0) solSpent = lamportsOut / 1e9;
    }

    await insertBuy({
      signature,
      buyer,
      blockTime: ts,
      mint: TARGET_MINT,
      tokenAmount: amt,
      solSpent,
      source: tx?.source || "helius",
    });
  }
}

// =====================
// API ROUTES
// =====================
app.get("/health", async (req, res) => {
  try {
    const stats = await getStats();
    res.json({ ok: true, stats, creator: CREATOR_WALLET, targetMint: TARGET_MINT || null });
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

app.get("/debug/top-mints", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 200), 1000);

    const r = await pool.query(
      `select payload
       from raw_events
       order by block_time desc
       limit $1`,
      [limit]
    );

    const counts = new Map();
    for (const row of r.rows) {
      const mints = extractMintsFromPayload(row.payload);
      for (const mint of mints) counts.set(mint, (counts.get(mint) || 0) + 1);
    }

    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([mint, count]) => ({ mint, count }));

    res.json({ ok: true, lookedAt: limit, top, targetMint: TARGET_MINT || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

app.get("/buyers", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 200);

    const r = await pool.query(
      `select signature, buyer_wallet, block_time, mint, token_amount, sol_spent, source
       from buys
       order by block_time desc
       limit $1`,
      [limit]
    );

    res.json({ ok: true, targetMint: TARGET_MINT || null, buyers: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

// Webhook
app.post("/webhook/helius", async (req, res) => {
  try {
    if (!isAuthorized(req)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const parsed = WebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: "expected array payload" });
    }

    const txs = parsed.data;
    let inserted = 0;

    for (const tx of txs) {
      const sig = tx.signature ?? tx.transaction?.signatures?.[0];
      const ts = tx.timestamp ? Number(tx.timestamp) : Math.floor(Date.now() / 1000);
      if (!sig) continue;

      await insertRawEvent(sig, ts, tx);
      inserted++;

      await parseBuysForTargetMint({ tx, signature: sig, ts });
    }

    res.json({ ok: true, inserted });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

// =====================
// WEBSITE (STATIC UI)
// =====================
app.use(express.static(publicDir));

// fallback: serve index.html for root
app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// =====================
// START
// =====================
const PORT = process.env.PORT || 3001;

(async () => {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`CREATOR_WALLET: ${CREATOR_WALLET}`);
    console.log(`TARGET_MINT: ${TARGET_MINT || "(not set)"}`);
  });
})();
