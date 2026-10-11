import type { PgliteDatabase } from "drizzle-orm/pglite";
import type * as schema from "../db/schema";

/**
 * Commands accept this database handle so tests can pass an in-memory Postgres.
 * The Next.js pool is cast to the same handle at the app boundary; both drivers
 * speak the Drizzle Postgres query API.
 */
export type CoreDb = PgliteDatabase<typeof schema>;

export async function inTx<T>(db: CoreDb, fn: (tx: CoreDb) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => fn(tx as unknown as CoreDb));
}
