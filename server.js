import express from "express";
import cors from "cors";
import { z } from "zod";
import Database from "better-sqlite3";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ===== CONFIG =====
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "dev-secret-change-me";
const CREATOR_WALLET =
  process.env.CREATOR_WALLET || "6XiPyaiogYybJZUiryTR216io3YNrLfz1QhFPrELGWuA";

// ===== DB (SQLite local) =====
const db = new Database("data.db");

// tables
db.exec(`
create table if not exists raw_events (
  id integer primary key autoincrement,
  signature text not null unique,
  block_time integer not null,
  payload text not null
);

create table if not exists buys (
  id integer primary key autoincrement,
  signature text not null,
  buyer_wallet text not null,
  block_time integer not null,
  mint text not null,
  token_amount real not null,
  sol_spent real,
  source text,
  unique(signature, buyer_wallet)
);
`);

// ===== Helpers =====
const WebhookSchema = z.array(z.any());

function insertRawEvent(signature, blockTime, payloadObj) {
  const stmt = db.prepare(
    `insert or ignore into raw_events(signature, block_time, payload) values(?,?,?)`
  );
  stmt.run(signature, blockTime, JSON.stringify(payloadObj));
}

function getStats() {
  const rawCount = db.prepare(`select count(*) as c from raw_events`).get().c;
  const buyCount = db.prepare(`select count(*) as c from buys`).get().c;
  return { rawCount, buyCount };
}

// ===== ROUTES =====

// health
app.get("/health", (req, res) => {
  res.json({ ok: true, stats: getStats() });
});

// debug latest raw events
app.get("/debug/raw", (req, res) => {
  const rows = db
    .prepare(`select signature, block_time from raw_events order by id desc limit 10`)
    .all();
  res.json({ ...getStats(), latest: rows });
});

// webhook receiver (Helius -> us)
app.post("/webhook/helius", (req, res) => {
  const auth = req.header("authorization") || "";
  if (auth !== `Bearer ${WEBHOOK_SECRET}`) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const parsed = WebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "expected array payload" });
  }

  const txs = parsed.data;

  for (const tx of txs) {
    const sig = tx.signature ?? tx.transaction?.signatures?.[0];
    const ts = tx.timestamp ? Number(tx.timestamp) : Math.floor(Date.now() / 1000);
    if (!sig) continue;

    insertRawEvent(sig, ts, tx);
  }

  res.json({ ok: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`CREATOR_WALLET: ${CREATOR_WALLET}`);
});
