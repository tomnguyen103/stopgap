import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { getDb, type Db } from "./client.js";
import { withBypassDb } from "./org-context.js";
import { apiKeyRequests, apiKeys, type ApiKeyRow } from "./schema.js";

/**
 * API key store (PHASE6 §6.7) — the credential layer behind the public REST surface and, through
 * it, the MCP server. Kept in `@stopgap/db` rather than in the console so the console route
 * handlers, the admin server actions, and any future deployable share ONE definition of what a
 * key is and when it is valid; a second copy would drift into a second authorization policy.
 *
 * The stance throughout is that the database is not trusted with the secret. Only a SHA-256 hash
 * is persisted, lookups are BY hash, and a revoked key stays as a row so the audit entries that
 * name it keep their provenance.
 */

/**
 * The scopes a key may carry. Deliberately mirrors the 6.1 role matrix rather than inventing a
 * parallel vocabulary: reads split by resource, and everything that MUTATES clinical state sits
 * behind the single `protocols:write` scope, so "may this integration change patient-facing
 * guidance" is one checkbox an admin can reason about, not a matrix they must assemble correctly.
 */
export const API_SCOPES = [
  "cases:read",
  "protocols:read",
  "protocols:write",
  "shadow:read",
  // Ticket 19. Three scopes rather than one `platform:read`, because the three answer different
  // questions and an integrator should be able to hold the narrowest one that does their job: a
  // supply-planning client needs the catalog and nothing about clinical risk, a monitoring client
  // needs scores and never the facility's stock levels.
  "signals:read",
  "scores:read",
  "catalog:read",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/** Narrow an untrusted string to a known scope — an unknown value is dropped, never coerced. */
export function isApiScope(v: unknown): v is ApiScope {
  return typeof v === "string" && (API_SCOPES as readonly string[]).includes(v);
}

/** The namespace every plaintext key carries, so a leaked string is recognizable as a Stopgap key. */
const KEY_NAMESPACE = "sk_live_";

/**
 * How many characters of the RANDOM segment the display prefix keeps.
 *
 * The namespace alone is NOT a prefix — it is the same eight bytes on every key ever minted, so a
 * column showing only `sk_live_` would answer "is this a Stopgap key" (already known) and never
 * "which of these three keys is the one the EHR integration uses", which is the question the admin
 * table exists to answer. Six base64url characters is ~36 bits: enough that a collision between two
 * keys in one deployment is not a practical concern, and irrelevant to guessing the other 220 bits.
 */
const KEY_PREFIX_RANDOM_CHARS = 6;

/** Stable advisory-lock key for API-key rate reservations (a constant unique to this concern). */
const API_RATE_LIMIT_LOCK = 611_407;

/** SHA-256 hex of a plaintext key — the only form of the secret that ever reaches Postgres. */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Mint a new key. The plaintext is `sk_live_` + 32 bytes of CSPRNG entropy in base64url (256 bits
 * — brute force is not a threat model, so the rate limiter does not have to double as one).
 *
 * `keyPrefix` deliberately spans the namespace AND the first few random characters. Slicing the
 * plaintext at the namespace boundary instead would store the identical literal on every row, and
 * the admin table, which uses this column to tell one key from another, would show one repeated
 * string — a display that looks informative and is not.
 *
 * The plaintext is RETURNED, never stored: `issueApiKey` writes only `keyHash` and `keyPrefix`, so
 * whoever issued the key is the only party that ever sees it. That is what makes a database read
 * — a dump, a replica, a backup on the wrong disk — insufficient to mint a usable credential:
 * SHA-256 is one-way, so a stolen hash authenticates nothing. The cost is that a lost key cannot
 * be recovered, only revoked and reissued; that is the intended trade.
 */
export function generateApiKey(): { plaintext: string; keyHash: string; keyPrefix: string } {
  const random = randomBytes(32).toString("base64url");
  const plaintext = `${KEY_NAMESPACE}${random}`;
  return {
    plaintext,
    keyHash: hashApiKey(plaintext),
    keyPrefix: `${KEY_NAMESPACE}${random.slice(0, KEY_PREFIX_RANDOM_CHARS)}`,
  };
}

export interface IssueApiKeyInput {
  /** The tenant this key acts as (PHASE6 §6.5) — see `apiKeys.orgId` in `schema.ts`. */
  orgId: string;
  name: string;
  scopes: ApiScope[];
  rateLimitPerHour: number;
  /** The human who issued it (a real `users.id`), or null when no IdP is wired. */
  createdByUserId?: string | null;
}

/**
 * Issue a key: mint, persist the hash, return the row PLUS the plaintext. The plaintext leaves
 * this function exactly once — the caller shows it to the issuing admin and drops it. Nothing in
 * this module ever logs it.
 */
export async function issueApiKey(
  input: IssueApiKeyInput,
  db: Db = getDb(),
): Promise<{ row: ApiKeyRow; plaintext: string }> {
  const { plaintext, keyHash, keyPrefix } = generateApiKey();
  const [row] = await db
    .insert(apiKeys)
    .values({
      orgId: input.orgId,
      name: input.name,
      keyHash,
      keyPrefix,
      scopes: input.scopes,
      rateLimitPerHour: input.rateLimitPerHour,
      createdByUserId: input.createdByUserId ?? null,
    })
    .returning();
  if (!row) throw new Error("issueApiKey: insert returned no row");
  return { row, plaintext };
}

/**
 * Every key, newest first — INCLUDING revoked ones. The admin list must show revocation state:
 * hiding revoked keys would make "did we already revoke that integration's key?" unanswerable
 * from the page that is supposed to answer it.
 */
export async function listApiKeys(orgId: string, db: Db = getDb()): Promise<ApiKeyRow[]> {
  return db.select().from(apiKeys).where(eq(apiKeys.orgId, orgId)).orderBy(desc(apiKeys.createdAt));
}

/**
 * Revoke a key. Soft (sets `revokedAt`), never a delete — the audit entries that name this key
 * must keep resolving to a row. The WHERE clause only matches a key that is still live, so a
 * second revoke returns `false` and the caller skips an audit entry claiming a revocation that
 * did not happen (same no-op-returns-false stance as `setUserDisabled`).
 */
export async function revokeApiKey(orgId: string, id: string, db: Db = getDb()): Promise<boolean> {
  const changed = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    // The org predicate is what stops one tenant's admin from revoking another tenant's
    // credential by guessing its uuid — a denial-of-service that RLS would also block, but that
    // must fail as a visible no-op here rather than depending on the backstop alone.
    .where(and(eq(apiKeys.orgId, orgId), eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return changed.length > 0;
}

/**
 * The live key behind a presented plaintext, or undefined.
 *
 * The lookup hashes the presented secret and matches on the hash column — it never compares the
 * secret itself, so there is no byte-by-byte comparison whose early exit could leak the key
 * through timing. What remains is the index probe, which depends on the HASH (a value an attacker
 * cannot steer without already knowing the key), not on how many leading characters they guessed
 * right. `revokedAt IS NULL` is part of the query rather than a post-check so a revoked key can
 * never be returned by a caller that forgets to test the field.
 *
 * Takes NO `orgId` (PHASE6 §6.5), for the same reason `getUserByOidc` does not: an inbound HTTP
 * request presents a secret and nothing else, so the key's `orgId` is the ANSWER — the value the
 * REST layer then opens its `withOrgDb` scope with. This is why `api_keys_key_hash_uq` stays
 * deployment-wide; a per-org unique index could not serve a lookup that has no org yet.
 *
 * It therefore runs through `withBypassDb` — one of exactly TWO sanctioned cross-tenant reads in
 * the application (the other is `getUserByOidc`), named so a reviewer can grep for them rather than
 * having to notice a missing `withOrgDb`. The blast radius is bounded by the QUERY, not by trust:
 * the predicate is an exact match on a 256-bit secret's SHA-256 plus `revoked_at IS NULL`, and the
 * read is `.limit(1)`, so the most this can ever return is the ONE row belonging to the credential
 * the caller already presented. "Unscoped" here means "not yet scoped" — the org it returns is
 * precisely what the REST layer opens its `withOrgDb` scope with.
 */
export async function findActiveApiKeyByPlaintext(plaintext: string): Promise<ApiKeyRow | undefined> {
  return withBypassDb(async (db) => {
    const [row] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, hashApiKey(plaintext)), isNull(apiKeys.revokedAt)))
      .limit(1);
    return row;
  });
}

/**
 * Stamp `lastUsedAt`. Best-effort by design: this is operational metadata ("is this integration
 * still alive?"), and a failed write here must never turn an otherwise-authorized request into an
 * error. The authoritative record of what the key did is the audit chain, not this column.
 *
 * Takes the key's `orgId` (PHASE6 §6.5) even though `id` alone identifies the row. `api_keys` is
 * RLS-protected, so this write must run on an org-scoped connection or it silently updates zero
 * rows — and "silently updates zero rows" is exactly what a best-effort call would never surface.
 * The caller has just resolved the key, so the org is free to pass and the update is honest.
 */
export async function touchApiKeyUsed(orgId: string, id: string, db: Db = getDb()): Promise<void> {
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(apiKeys.orgId, orgId), eq(apiKeys.id, id)));
}

/**
 * Reserve one request slot for a key inside its sliding window — the same shape as
 * `reserveDemoRun`, for the same reason.
 *
 * Within ONE transaction: take a transaction-scoped advisory lock keyed to this api key, count
 * the rows already in the window, and insert only if there is room. A plain count-then-insert
 * lets N concurrent requests all read `recent < limit` and all insert, blowing straight past the
 * cap. Row locks cannot fix it either: the race is two callers inserting NEW rows, and `FOR
 * UPDATE` over existing rows does not block a phantom insert. The advisory lock is what serializes
 * them; it releases on commit/rollback.
 *
 * The lock takes the two-argument form `(constant, hashtext(id))` so keys serialize against
 * THEMSELVES only — one busy integration must not block every other integration's reservations.
 *
 * RETENTION. The same transaction prunes this key's rows that have aged out of the window. Only the
 * last hour is ever read, so without a prune the table grows forever — at the default 1000/hour cap
 * that is ~8.8M rows per key per year, all of it dead weight in the index every live count has to
 * walk past. The prune lives HERE, not in a scheduled job, for two reasons. It is already inside the
 * per-key advisory lock, so it cannot race the count that decides admission — a separate job would
 * need to take the same lock or risk deleting rows a concurrent reservation is mid-count over. And a
 * job is a second thing to deploy, schedule, and notice the absence of: an operator who never wired
 * it up would get unbounded growth with no signal, whereas a prune on the write path cannot be
 * forgotten because the write path is the only thing that creates the rows.
 *
 * The cutoff carries a full extra window of margin (rows older than `since - windowLength`) rather
 * than deleting everything before `since`. The margin costs one hour of retained rows and buys the
 * guarantee that the delete can never remove a row another caller's window still counts, even if a
 * future caller passes a longer window than this one did.
 */
export async function reserveApiKeyRequest(
  apiKeyId: string,
  since: Date,
  limit: number,
): Promise<{ allowed: boolean; recent: number }> {
  const db = getDb();
  const windowMs = Math.max(0, Date.now() - since.getTime());
  const pruneBefore = new Date(since.getTime() - windowMs);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${API_RATE_LIMIT_LOCK}, hashtext(${apiKeyId}))`);
    // Before the count, not after: a key that is AT its limit returns early, and that is precisely
    // the key with the most accumulated rows — pruning after the decision would never reach it.
    await tx
      .delete(apiKeyRequests)
      .where(and(eq(apiKeyRequests.apiKeyId, apiKeyId), lt(apiKeyRequests.at, pruneBefore)));
    const [row] = await tx
      .select({ n: count() })
      .from(apiKeyRequests)
      .where(and(eq(apiKeyRequests.apiKeyId, apiKeyId), gte(apiKeyRequests.at, since)));
    const recent = row?.n ?? 0;
    if (recent >= limit) return { allowed: false, recent };
    await tx.insert(apiKeyRequests).values({ apiKeyId });
    return { allowed: true, recent: recent + 1 };
  });
}
