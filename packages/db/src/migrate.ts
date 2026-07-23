import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getEnv } from "@stopgap/core/env";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** Apply generated SQL migrations from ./drizzle. Run via `pnpm db:migrate`. */
async function main() {
  const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
  const sql = postgres(getEnv().DATABASE_URL, { max: 1 });
  const db = drizzle(sql);
  console.log(`[migrate] applying migrations from ${migrationsFolder}`);
  await migrate(db, { migrationsFolder });
  await sql.end();
  console.log("[migrate] done");
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
