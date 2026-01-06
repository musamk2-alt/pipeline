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
const TARGET_MINT = (process.env.TARGET_MINT || "").trim(); // later

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL missing");
  process.exit(1);
}

// ✅ Supabase session pooler safe
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
  min: 0,
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: 10000,
  allowExitOnIdle: true,
});

const WebhookSchema = z.array(z.any());

// =====================
// STATIC UI
// =====================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// =====================
// BADGE CATALOG
// =====================
const BADGE_CATALOG = {
  // Quest badges (mapped 1:1 to quests)
  RESPECT_PAID: {
    cat: "Quest",
    rarity: "Common",
    label: "Respect Paid",
    desc: "Completed the hourly quest when it was SHOW RESPECT hour.",
  },
  EARLY_SUPPORTER: {
    cat: "Quest",
    rarity: "Common",
    label: "Early Supporter",
    desc: "Completed the hourly quest when it was FIRST BLOOD hour.",
  },
  SIGNAL_SENDER: {
    cat: "Quest",
    rarity: "Common",
    label: "Signal Sender",
    desc: "Completed the hourly quest when it was SIGNAL CHECK hour.",
  },

  // Rarity badges (rank-based)
  FIRST_CLAIMER: {
    cat: "Rarity",
    rarity: "Legendary",
    label: "First Claimer",
    desc: "Rank #1 claim of the hour.",
  },
  TOP3_CLAIMER: {
    cat: "Rarity",
    rarity: "Rare",
    label: "Top 3 Claimer",
    desc: "Rank #1–#3 claim of the hour.",
  },

  // Streak badges
  STREAK_2: { cat: "Streak", rarity: "Uncommon", label: "Streak 2", desc: "Claimed 2 hourly quests in a row." },
  STREAK_3: { cat: "Streak", rarity: "Uncommon", label: "Streak 3", desc: "Claimed 3 hourly quests in a row." },
  STREAK_5: { cat: "Streak", rarity: "Rare", label: "Streak 5", desc: "Claimed 5 hourly quests in a row." },
  STREAK_10:{ cat: "Streak", rarity: "Legendary", label: "Streak 10", desc: "Claimed 10 hourly quests in a row." },

  // Memory badges
  FIRST_SEEN:   { cat: "Memory", rarity: "Common", label: "First Seen", desc: "First interaction detected with the creator wallet." },
  REGULAR:      { cat: "Memory", rarity: "Uncommon", label: "Regular", desc: "Hit 5 creator-wallet interactions." },
  KNOWN_ENTITY: { cat: "Memory", rarity: "Rare", label: "Known Entity", desc: "Hit 10 creator-wallet interactions." },
};

function badgeInfo(code) {
  return BADGE_CATALOG[code] || { cat: "Unknown", rarity: "Common", label: code, desc: "—" };
}

// =====================
// DB INIT (migration-safe)
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
    create table if not exists wallet_memory (
      wallet text primary key,
      first_seen bigint not null,
      last_seen bigint not null,
      interactions int not null default 0,
      sol_in numeric not null default 0,
      sol_out numeric not null default 0,
      vibe text not null default 'neutral'
    );
  `);

  await pool.query(`
    create table if not exists wallet_events (
      id bigserial primary key,
      wallet text not null,
      signature text not null,
      block_time bigint not null,
      kind text not null,
      amount numeric,
      other_wallet text
    );
  `);

  await pool.query(`
    create index if not exists idx_wallet_events_wallet_time
    on wallet_events(wallet, block_time desc);
  `);

  await pool.query(`
    create table if not exists quest_claims (
      id bigserial primary key,
      quest_key text not null,
      wallet text not null,
      signature text not null unique,
      created_at timestamptz not null default now()
    );
  `);

  await pool.query(`alter table quest_claims add column if not exists hour_index bigint;`);
  await pool.query(`create index if not exists idx_quest_claims_quest_key on quest_claims(quest_key);`);
  await pool.query(`create index if not exists idx_quest_claims_wallet_hour on quest_claims(wallet, hour_index desc);`);

  await pool.query(`
    create table if not exists wallet_profile (
      wallet text primary key,
      codename text not null,
      bio text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    create table if not exists wallet_badges (
      id bigserial primary key,
      wallet text not null,
      badge text not null,
      reason text,
      created_at timestamptz not null default now(),
      unique(wallet, badge)
    );
  `);
  await pool.query(`create index if not exists idx_wallet_badges_wallet on wallet_badges(wallet);`);
}

// =====================
// AUTH
// =====================
function normalize(v) {
  return String(v || "").trim().replace(/\s+/g, " ");
}
function isAuthorized(req) {
  if (!WEBHOOK_SECRET) return false;
  const h = normalize(req.header("authorization"));
  return (
    h === `Bearer ${WEBHOOK_SECRET}` ||
    h === `Authorization: Bearer ${WEBHOOK_SECRET}` ||
    h.toLowerCase() === `bearer ${WEBHOOK_SECRET}`.toLowerCase()
  );
}

// =====================
// HELPERS
// =====================
async function insertRawEvent(sig, ts, payload) {
  await pool.query(
    `insert into raw_events(signature, block_time, payload)
     values($1,$2,$3)
     on conflict (signature) do nothing`,
    [sig, BigInt(ts), payload]
  );
}

async function getStats() {
  const r = await pool.query(`select count(*)::int c from raw_events`);
  const b = await pool.query(`select count(*)::int c from buys`);
  return { rawCount: r.rows[0].c, buyCount: b.rows[0].c };
}

// =====================
// DETERMINISTIC CODENAME
// =====================
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

const ADJ = [
  "Neon","Silent","Iron","Turbo","Crypto","Phantom","Solar","Lunar","Velvet","Feral",
  "Glitch","Quantum","Arcane","Liquid","Hollow","Vivid","Static","Hyper","Frost","Ember",
];
const NOUN = [
  "Warden","Mantis","Fox","Raven","Shark","Otter","Golem","Wisp","Nomad","Pilot",
  "Cipher","Monk","Ranger","Drifter","Oracle","Scribe","Viper","Knight","Sprite","Gambit",
];

function codenameForWallet(wallet) {
  const h = djb2(wallet);
  const a = ADJ[h % ADJ.length];
  const n = NOUN[(h >>> 8) % NOUN.length];
  const tag = String(h % 1000).padStart(3, "0");
  return `${a} ${n} #${tag}`;
}

async function ensureProfile(wallet) {
  const exists = await pool.query(`select wallet, codename from wallet_profile where wallet=$1`, [wallet]);
  if (exists.rows.length) return exists.rows[0];

  const codename = codenameForWallet(wallet);
  await pool.query(
    `insert into wallet_profile(wallet, codename, bio)
     values($1,$2,'') on conflict do nothing`,
    [wallet, codename]
  );
  const r = await pool.query(`select wallet, codename from wallet_profile where wallet=$1`, [wallet]);
  return r.rows[0] || { wallet, codename };
}

async function awardBadge(wallet, badge, reason) {
  await pool.query(
    `insert into wallet_badges(wallet, badge, reason)
     values($1,$2,$3)
     on conflict(wallet,badge) do nothing`,
    [wallet, badge, reason || null]
  );
}

// =====================
// MEMORY (prelaunch)
// =====================
async function upsertWalletMemory({ wallet, ts, solIn = 0, solOut = 0 }) {
  await ensureProfile(wallet);

  await pool.query(
    `
    insert into wallet_memory(wallet, first_seen, last_seen, interactions, sol_in, sol_out, vibe)
    values($1,$2,$2,1,$3,$4,'neutral')
    on conflict (wallet) do update set
      last_seen = excluded.last_seen,
      interactions = wallet_memory.interactions + 1,
      sol_in = wallet_memory.sol_in + excluded.sol_in,
      sol_out = wallet_memory.sol_out + excluded.sol_out
    `,
    [wallet, BigInt(ts), solIn, solOut]
  );

  const row = await pool.query(`select sol_in, sol_out, interactions from wallet_memory where wallet=$1`, [wallet]);
  const inAmt = Number(row.rows[0]?.sol_in ?? 0);
  const outAmt = Number(row.rows[0]?.sol_out ?? 0);
  const interactions = Number(row.rows[0]?.interactions ?? 0);

  let newVibe = "neutral";
  if (outAmt > inAmt * 1.5 && outAmt > 0.01) newVibe = "supporter";
  else if (inAmt > outAmt * 1.5 && inAmt > 0.01) newVibe = "beneficiary";

  await pool.query(`update wallet_memory set vibe=$2 where wallet=$1`, [wallet, newVibe]);

  if (interactions === 1) await awardBadge(wallet, "FIRST_SEEN", "First interaction with creator");
  if (interactions === 5) await awardBadge(wallet, "REGULAR", "5 interactions milestone");
  if (interactions === 10) await awardBadge(wallet, "KNOWN_ENTITY", "10 interactions milestone");
}

async function insertWalletEvent({ wallet, signature, ts, kind, amount, otherWallet }) {
  await pool.query(
    `insert into wallet_events(wallet, signature, block_time, kind, amount, other_wallet)
     values($1,$2,$3,$4,$5,$6)`,
    [wallet, signature, BigInt(ts), kind, amount ?? null, otherWallet ?? null]
  );
}

async function parseMemoryFromTx({ tx, sig, ts }) {
  const nativeTransfers = tx?.nativeTransfers || [];
  if (!Array.isArray(nativeTransfers) || nativeTransfers.length === 0) return;

  for (const nt of nativeTransfers) {
    const from = nt?.fromUserAccount;
    const to = nt?.toUserAccount;
    const lamports = nt?.amount;
    if (!from || !to || typeof lamports !== "number") continue;

    const sol = lamports / 1e9;

    if (to === CREATOR_WALLET && from !== CREATOR_WALLET) {
      await upsertWalletMemory({ wallet: from, ts, solIn: 0, solOut: sol });
      await insertWalletEvent({ wallet: from, signature: sig, ts, kind: "sol_out_to_creator", amount: sol, otherWallet: CREATOR_WALLET });
    } else if (from === CREATOR_WALLET && to !== CREATOR_WALLET) {
      await upsertWalletMemory({ wallet: to, ts, solIn: sol, solOut: 0 });
      await insertWalletEvent({ wallet: to, signature: sig, ts, kind: "sol_in_from_creator", amount: sol, otherWallet: CREATOR_WALLET });
    }
  }
}

// =====================
// QUESTS (deterministic rotation)
// =====================
function getQuestKey(now = Date.now()) {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}`;
}
function hourIndexFromNow(now = Date.now()) {
  return Math.floor(now / 1000 / 3600);
}
function hash32(str){
  let h = 0;
  for (let i=0;i<str.length;i++) h = (h*31 + str.charCodeAt(i)) >>> 0;
  return h>>>0;
}

// ✅ All quests live here (the whole list)
const QUESTS = [
  {
    id:"respect",
    title:"SHOW RESPECT",
    rule:`Send at least 0.0005 SOL to the creator wallet.`,
    type:"sol_to_creator_min",
    minSol:0.0005,
    badge:"RESPECT_PAID",
  },
  {
    id:"first-blood",
    title:"FIRST BLOOD",
    rule:`Send at least 0.001 SOL to the creator wallet.`,
    type:"sol_to_creator_min",
    minSol:0.001,
    badge:"EARLY_SUPPORTER",
  },
  {
    id:"signal",
    title:"SIGNAL CHECK",
    rule:`Any SOL interaction to the creator wallet (>= 0.0001 SOL).`,
    type:"sol_to_creator_min",
    minSol:0.0001,
    badge:"SIGNAL_SENDER",
  },
];

function pickQuest(questKey) {
  const idx = hash32(questKey) % QUESTS.length;
  return QUESTS[idx];
}

function getQuest(now = Date.now()) {
  const questKey = getQuestKey(now);
  const quest = pickQuest(questKey);

  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  const end = d.getTime() + 60 * 60 * 1000;
  const msLeft = Math.max(0, end - now);

  return {
    questKey,
    hourIndex: hourIndexFromNow(now),
    ...quest,
    creatorWallet: CREATOR_WALLET,
    endsAt: end,
    msLeft,
  };
}

function questForHourIndex(hourIndex){
  const key = getQuestKey(hourIndex*3600*1000);
  const q = pickQuest(key);
  return { ...q, questKey: key, hourIndex };
}

async function verifyQuestClaim({ quest, wallet, signature }) {
  const r = await pool.query(`select payload from raw_events where signature=$1 limit 1`, [signature]);
  if (r.rows.length === 0) return { ok: false, reason: "signature_not_ingested" };

  const payload = r.rows[0].payload;
  const nativeTransfers = payload?.nativeTransfers || [];
  if (!Array.isArray(nativeTransfers) || nativeTransfers.length === 0) {
    return { ok: false, reason: "no_native_transfers_in_payload" };
  }

  const minLamports = Math.floor(quest.minSol * 1e9);
  const hit = nativeTransfers.some((t) => {
    const from = t?.fromUserAccount;
    const to = t?.toUserAccount;
    const amt = t?.amount;
    return from === wallet && to === CREATOR_WALLET && typeof amt === "number" && amt >= minLamports;
  });
  if (!hit) return { ok: false, reason: "rule_not_met" };
  return { ok: true };
}

async function calcStreak(wallet, currentHourIndex) {
  const r = await pool.query(
    `select hour_index from quest_claims where wallet=$1 and hour_index is not null order by hour_index desc limit 80`,
    [wallet]
  );
  const hours = r.rows.map((x) => Number(x.hour_index)).filter(Number.isFinite);
  const set = new Set(hours);

  let streak = 0;
  while (set.has(currentHourIndex - streak)) streak++;
  return streak;
}

// =====================
// ROUTES
// =====================
app.get("/", (_, res) => res.sendFile(path.join(publicDir, "index.html")));

app.get("/badges/catalog", (_, res) => {
  res.json({ ok: true, catalog: BADGE_CATALOG });
});

app.get("/badges/progress/:wallet", async (req, res) => {
  const wallet = req.params.wallet;

  const unlockedR = await pool.query(`select badge from wallet_badges where wallet=$1`, [wallet]);
  const unlocked = new Set(unlockedR.rows.map((r) => r.badge));

  const memR = await pool.query(`select interactions from wallet_memory where wallet=$1`, [wallet]);
  const interactions = Number(memR.rows[0]?.interactions ?? 0);

  const nowHour = Math.floor(Date.now() / 1000 / 3600);
  const hoursR = await pool.query(
    `select hour_index from quest_claims where wallet=$1 and hour_index is not null order by hour_index desc limit 120`,
    [wallet]
  );
  const set = new Set(hoursR.rows.map((x) => Number(x.hour_index)).filter(Number.isFinite));
  let streak = 0;
  while (set.has(nowHour - streak)) streak++;

  const targets = [
    { badge: "REGULAR", need: 5, have: interactions },
    { badge: "KNOWN_ENTITY", need: 10, have: interactions },
    { badge: "STREAK_2", need: 2, have: streak },
    { badge: "STREAK_3", need: 3, have: streak },
    { badge: "STREAK_5", need: 5, have: streak },
    { badge: "STREAK_10", need: 10, have: streak },
  ];

  const progress = targets.map((t) => {
    const haveClamped = Math.max(0, Math.min(t.have, t.need));
    const pct = t.need === 0 ? 100 : Math.floor((haveClamped / t.need) * 100);
    const remaining = Math.max(0, t.need - t.have);
    return {
      badge: t.badge,
      info: badgeInfo(t.badge),
      unlocked: unlocked.has(t.badge),
      have: t.have,
      need: t.need,
      remaining,
      pct,
      nextUnlockIn: remaining === 0 ? null : remaining,
    };
  });

  // also show quest badges as unlocked/locked based on wallet_badges
  const questProgress = QUESTS.map(q => ({
    badge: q.badge,
    info: badgeInfo(q.badge),
    unlocked: unlocked.has(q.badge),
    have: unlocked.has(q.badge) ? 1 : 0,
    need: 1,
    remaining: unlocked.has(q.badge) ? 0 : 1,
    pct: unlocked.has(q.badge) ? 100 : 0,
    nextUnlockIn: unlocked.has(q.badge) ? null : 1,
  }));

  res.json({ ok: true, wallet, interactions, streak, progress, questProgress });
});

app.get("/health", async (_, res) => {
  res.json({
    ok: true,
    stats: await getStats(),
    creator: CREATOR_WALLET,
    targetMint: TARGET_MINT || null,
  });
});

// ✅ Quest overview (A)
app.get("/quest/overview", async (_, res) => {
  const now = Date.now();
  const active = getQuest(now);
  const h = active.hourIndex;

  // deterministic preview: next 3 hours (locked)
  const next = [1,2,3].map(d => questForHourIndex(h + d)).map(q => ({
    id: q.id,
    title: q.title,
    rule: q.rule,
    minSol: q.minSol,
    badge: q.badge,
    badgeInfo: badgeInfo(q.badge),
    hourIndex: q.hourIndex,
    questKey: q.questKey,
  }));

  // show full pool to prove it's not random chaos
  const poolList = QUESTS.map(q => ({
    id:q.id, title:q.title, rule:q.rule, minSol:q.minSol, badge:q.badge, badgeInfo: badgeInfo(q.badge)
  }));

  const c = await pool.query(`select count(*)::int as c from quest_claims where quest_key=$1`, [active.questKey]);

  res.json({
    ok:true,
    active: {
      questKey: active.questKey,
      hourIndex: active.hourIndex,
      id: active.id,
      title: active.title,
      rule: active.rule,
      minSol: active.minSol,
      endsAt: active.endsAt,
      msLeft: active.msLeft,
      creatorWallet: active.creatorWallet,
      claims: c.rows[0].c,
      badge: active.badge,
      badgeInfo: badgeInfo(active.badge),
    },
    next,
    pool: poolList,
    deterministic: true,
  });
});

app.get("/debug/raw", async (_, res) => {
  const r = await pool.query(`
    select signature, block_time
    from raw_events
    order by block_time desc
    limit 10
  `);
  res.json({ latest: r.rows });
});

app.get("/debug/top-mints", async (_, res) => {
  const r = await pool.query(`select payload from raw_events order by block_time desc limit 250`);

  const map = new Map();
  for (const row of r.rows) {
    const tt = row.payload?.tokenTransfers || [];
    if (!Array.isArray(tt)) continue;
    for (const t of tt) if (t?.mint) map.set(t.mint, (map.get(t.mint) || 0) + 1);
  }

  res.json({
    ok: true,
    top: [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([mint, count]) => ({ mint, count })),
  });
});

app.get("/buyers", async (_, res) => {
  const r = await pool.query(`
    select buyer_wallet, token_amount, sol_spent, signature
    from buys
    order by block_time desc
    limit 50
  `);
  res.json({ ok: true, buyers: r.rows });
});

app.get("/memory/actors", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const r = await pool.query(
    `
    select
      m.wallet,
      p.codename,
      m.interactions,
      m.sol_in,
      m.sol_out,
      m.vibe,
      coalesce(b.badge_count, 0) as badge_count
    from wallet_memory m
    left join wallet_profile p on p.wallet = m.wallet
    left join (
      select wallet, count(*)::int as badge_count
      from wallet_badges
      group by wallet
    ) b on b.wallet = m.wallet
    order by m.interactions desc, m.last_seen desc
    limit $1
    `,
    [limit]
  );
  res.json({ ok: true, actors: r.rows });
});

app.get("/memory/wallet/:addr", async (req, res) => {
  const addr = req.params.addr;
  const profile = await ensureProfile(addr);

  const meta = await pool.query(`select * from wallet_memory where wallet=$1`, [addr]);
  const events = await pool.query(
    `select signature, block_time, kind, amount, other_wallet
     from wallet_events
     where wallet=$1
     order by block_time desc
     limit 100`,
    [addr]
  );

  const badgesRaw = await pool.query(
    `select badge, reason, created_at
     from wallet_badges
     where wallet=$1
     order by created_at desc
     limit 200`,
    [addr]
  );

  const badges = badgesRaw.rows.map((b) => ({ ...b, info: badgeInfo(b.badge) }));

  res.json({
    ok: true,
    profile,
    wallet: meta.rows[0] || null,
    events: events.rows,
    badges,
  });
});

// quest endpoints
app.get("/quest/current", async (_, res) => {
  const q = getQuest(Date.now());
  const c = await pool.query(`select count(*)::int as c from quest_claims where quest_key=$1`, [q.questKey]);

  res.json({
    ok: true,
    quest: {
      questKey: q.questKey,
      title: q.title,
      rule: q.rule,
      minSol: q.minSol,
      creatorWallet: q.creatorWallet,
      endsAt: q.endsAt,
      msLeft: q.msLeft,
      claims: c.rows[0].c,
      badge: q.badge,
      badgeInfo: badgeInfo(q.badge),
    },
  });
});

app.get("/quest/claims", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 10), 50);
  const q = getQuest(Date.now());

  const r = await pool.query(
    `select wallet, signature, created_at
     from quest_claims
     where quest_key=$1
     order by created_at asc
     limit $2`,
    [q.questKey, limit]
  );

  const claims = r.rows.map((x, i) => ({ ...x, rank: i + 1 }));
  res.json({ ok: true, questKey: q.questKey, claims });
});

app.post("/quest/claim", async (req, res) => {
  const Body = z.object({ wallet: z.string().min(20), signature: z.string().min(20) }).safeParse(req.body);
  if (!Body.success) return res.status(400).json({ ok: false, error: "bad_request" });

  const { wallet, signature } = Body.data;
  const q = getQuest(Date.now());

  const verified = await verifyQuestClaim({ quest: q, wallet, signature });
  if (!verified.ok) return res.status(400).json({ ok: false, error: verified.reason });

  await ensureProfile(wallet);

  try {
    await pool.query(
      `insert into quest_claims(quest_key, wallet, signature, hour_index) values($1,$2,$3,$4)`,
      [q.questKey, wallet, signature, q.hourIndex]
    );
  } catch {
    return res.status(409).json({ ok: false, error: "already_claimed" });
  }

  const earlier = await pool.query(
    `select count(*)::int as c
     from quest_claims
     where quest_key=$1
       and created_at < (select created_at from quest_claims where signature=$2)`,
    [q.questKey, signature]
  );
  const myRank = (earlier.rows[0]?.c ?? 0) + 1;

  const awarded = [];

  // ✅ quest badge
  await awardBadge(wallet, q.badge, `Quest ${q.questKey}: ${q.title}`);
  awarded.push({ badge: q.badge, info: badgeInfo(q.badge) });

  // rank badges
  if (myRank === 1) {
    await awardBadge(wallet, "FIRST_CLAIMER", `First claim of ${q.questKey}`);
    awarded.push({ badge: "FIRST_CLAIMER", info: badgeInfo("FIRST_CLAIMER") });
  }
  if (myRank <= 3) {
    await awardBadge(wallet, "TOP3_CLAIMER", `Top 3 claim of ${q.questKey}`);
    awarded.push({ badge: "TOP3_CLAIMER", info: badgeInfo("TOP3_CLAIMER") });
  }

  // streak
  const streak = await calcStreak(wallet, q.hourIndex);

  if (streak >= 2) { await awardBadge(wallet, "STREAK_2", "Claimed 2 hourly quests in a row"); awarded.push({ badge:"STREAK_2", info: badgeInfo("STREAK_2") }); }
  if (streak >= 3) { await awardBadge(wallet, "STREAK_3", "Claimed 3 hourly quests in a row"); awarded.push({ badge:"STREAK_3", info: badgeInfo("STREAK_3") }); }
  if (streak >= 5) { await awardBadge(wallet, "STREAK_5", "Claimed 5 hourly quests in a row"); awarded.push({ badge:"STREAK_5", info: badgeInfo("STREAK_5") }); }
  if (streak >= 10){ await awardBadge(wallet, "STREAK_10", "Claimed 10 hourly quests in a row"); awarded.push({ badge:"STREAK_10", info: badgeInfo("STREAK_10") }); }

  res.json({ ok: true, questKey: q.questKey, title: q.title, yourRank: myRank, streak, awarded });
});

// webhook
app.post("/webhook/helius", async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const parsed = WebhookSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "expected array" });

  for (const tx of parsed.data) {
    const sig = tx.signature ?? tx.transaction?.signatures?.[0];
    const ts = tx.timestamp ?? Math.floor(Date.now() / 1000);
    if (!sig) continue;

    await insertRawEvent(sig, ts, tx);
    await parseMemoryFromTx({ tx, sig, ts });
  }

  res.json({ ok: true });
});

// START
const PORT = process.env.PORT || 3001;

async function shutdown() {
  try { await pool.end(); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

(async () => {
  await initDb();
  app.listen(PORT, () => console.log(`✅ http://localhost:${PORT}`));
})();
