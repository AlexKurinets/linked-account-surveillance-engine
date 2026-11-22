import { type Db, connect, migrate } from "../src/db.js";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://surv:surv@localhost:5546/surv_test";

/** A clean schema in the test database. */
export async function freshDb(): Promise<Db> {
  const db = connect(TEST_DB);
  await db.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  return db;
}
