import { getDb } from "../db/client";
import type { CoreDb } from "./db";

/** App-role pool, cast so commands can run against either driver. */
export function runtimeDb(): CoreDb {
  return getDb() as unknown as CoreDb;
}
