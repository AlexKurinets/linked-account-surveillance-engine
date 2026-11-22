import fs from "node:fs";
import path from "node:path";
import pg from "pg";

// Return bigint ids as numbers and dates as plain strings; we never exceed 2^53 here.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? "postgres://surv:surv@localhost:5546/surv";
}

export function connect(url = databaseUrl()): Db {
  return new pg.Pool({ connectionString: url, max: 6 });
}

export async function migrate(db: Db): Promise<void> {
  const sql = fs.readFileSync(path.resolve(process.env.SURV_SCHEMA ?? "db/schema.sql"), "utf8");
  await db.query(sql);
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getConfigValue<T>(db: Db | Tx, key: string): Promise<T | null> {
  const r = await db.query("SELECT value FROM engine_config WHERE key = $1", [key]);
  return r.rows.length ? (r.rows[0].value as T) : null;
}

export async function setConfigValue(db: Db | Tx, key: string, value: unknown, at: Date): Promise<void> {
  await db.query(
    `INSERT INTO engine_config (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, JSON.stringify(value), at],
  );
}
