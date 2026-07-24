import { getEnv } from "@stopgap/core/env";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

/**
 * Lazily-constructed singleton DB client. Kept lazy so packages can import query helpers
 * without opening a connection at module load (matters for tests and the console).
 */
let sqlClient: ReturnType<typeof postgres> | undefined;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getDb() {
  if (!dbInstance) {
    sqlClient = postgres(getEnv().DATABASE_URL, { max: 10 });
    dbInstance = drizzle(sqlClient, { schema });
  }
  return dbInstance;
}

/**
 * Is the database reachable (PHASE6 §6.4 readiness)? Runs `select 1` and returns a boolean rather
 * than throwing, so `/readyz` can report the database as down without 500-ing — honest "not ready".
 */
export async function pingDb(): Promise<boolean> {
  try {
    await getDb().execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

/** Close the pool (tests, graceful shutdown). */
export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = undefined;
    dbInstance = undefined;
  }
}

export type Db = ReturnType<typeof getDb>;
