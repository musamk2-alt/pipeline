import { Pool } from "pg";

let _pool;

export function db() {
  if (_pool) return _pool;

  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) throw new Error("DATABASE_URL missing");

  _pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PG_MAX || 1),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000
  });

  return _pool;
}

export async function initDbOnce() {
  const pool = db();
  await pool.query(`
    create table if not exists raw_events (
      id bigserial primary key,
      signature text not null unique,
      block_time bigint,
      payload jsonb,
      created_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    create table if not exists buy_events (
      id bigserial primary key,
      signature text not null unique,
      wallet text,
      mint text,
      amount numeric,
      block_time bigint,
      created_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    create table if not exists wallet_memory (
      wallet text primary key,
      codename text,
      vibe text not null default 'neutral',
      interactions int not null default 0,
      updated_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    create table if not exists wallet_events (
      id bigserial primary key,
      wallet text not null,
      signature text not null,
      kind text not null,
      amount numeric,
      other_wallet text,
      mint text,
      block_time bigint,
      created_at timestamptz not null default now()
    );
    create index if not exists wallet_events_wallet_idx on wallet_events(wallet);
  `);

  await pool.query(`
    create table if not exists wallet_badges (
      id bigserial primary key,
      wallet text not null,
      badge text not null,
      signature text,
      created_at timestamptz not null default now(),
      unique(wallet, badge)
    );
  `);

  await pool.query(`
    create table if not exists quest_claims (
      id bigserial primary key,
      hour_index int not null,
      wallet text not null,
      signature text not null,
      badge text not null,
      created_at timestamptz not null default now(),
      unique(hour_index, wallet)
    );
  `);

  await pool.query(`
    create table if not exists mint_counter (
      mint text primary key,
      count int not null default 0,
      updated_at timestamptz not null default now()
    );
  `);
}
