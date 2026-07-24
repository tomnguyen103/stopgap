import { z } from "zod";

/**
 * Central environment schema. Parsed lazily so packages that only need a subset (e.g.
 * ingest needs feed URLs, not DB) don't crash on unrelated missing vars. Every field has
 * a sensible local-dev default so the local gate runs with zero configuration.
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().default("postgres://stopgap:stopgap@localhost:5433/stopgap"),

  TEMPORAL_ADDRESS: z.string().default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().default("default"),
  TEMPORAL_TASK_QUEUE: z.string().default("stopgap-cases"),

  LLM_PROVIDER: z.enum(["gemini", "ollama"]).default("ollama"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-3.5-flash-lite"),
  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default("mistral"),

  OPENFDA_BASE_URL: z.string().default("https://api.fda.gov"),
  OPENFDA_API_KEY: z.string().optional(),
  RXNORM_BASE_URL: z.string().default("https://rxnav.nlm.nih.gov"),
  // ASHP AHFS drug-shortages feed (ASHP-Software/drugShortagesDoc). The live feed requires
  // an auth key from softwaresupport@ashp.org; absent it, the ASHP poller is stubbed.
  ASHP_BASE_URL: z.string().default("https://ahfs-staging.firebaseio.com"),
  ASHP_AUTH_KEY: z.string().optional(),

  LANGFUSE_BASE_URL: z.string().default("http://localhost:3001"),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  COMMS_FROM: z.string().default("stopgap@example.com"),
  /** Comma-separated pharmacy distribution list for approved protocols. */
  COMMS_PHARMACY_TO: z.string().default(""),
  COMMS_DEMO_INBOX: z.string().optional(),
  EHR_WEBHOOK_URL: z.string().default("http://localhost:4000/ehr/formulary-flag"),

  /**
   * Public-demo mode (PROJECT_PLAN §11). "on" makes the console a read-only guest surface:
   * reviews and exception resolutions are refused, and the only mutation a visitor can make
   * is starting a demo shortage. Off by default so a real deployment is never accidentally
   * read-only.
   */
  STOPGAP_DEMO_MODE: z.enum(["on", "off"]).default("off"),
  /**
   * Daily LLM spend cap in USD. Applies to every deployment, not just the demo — a scheduled
   * poll spends the same dollars a visitor does. Unset OR empty means no cap: a hospital
   * deployment must not silently downgrade clinical calls to a 7B local model because nobody
   * configured a number. Over the cap, routing is restricted to the free local provider.
   *
   * The empty-string preprocess matters: `LLM_DAILY_USD_CAP=` in an env file is how "no cap"
   * is written, and `z.coerce.number()` would turn "" into 0 — a $0 cap that routes every
   * call to the local model, the exact opposite of "no cap".
   */
  LLM_DAILY_USD_CAP: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.coerce.number().nonnegative().optional(),
  ),
  /** Rate limit on visitor-started demo scenarios, per rolling hour (deployment-wide). */
  DEMO_MAX_RUNS_PER_HOUR: z.coerce.number().int().positive().default(6),

  /**
   * Keyed-HMAC secret for the audit chain (PHASE6 §6.2, CWE-345). When set, new audit rows
   * are hashed with HMAC-SHA256 under this key (`v2` scheme) instead of a bare SHA-256
   * (`v1`), so an attacker with only DB write access can no longer recompute a valid chain —
   * the key lives outside the database (document a KMS as the production home). Empty/unset
   * means the deployment stays on `v1`: honest non-configuration, not a silent downgrade of a
   * chain that was already keyed. Existing `v1` rows keep verifying either way.
   */
  AUDIT_HMAC_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
  /**
   * Append-only file the hourly anchor writes `(ts, maxAuditId, headHash)` to — the external
   * anchor that makes wholesale chain rewrites detectable even to someone who holds the HMAC
   * key. In compose this points at a Docker volume; locally it defaults under the repo. The
   * directory is created on first write.
   */
  AUDIT_ANCHOR_FILE: z.string().default(".audit-anchors/anchors.log"),
  /**
   * Optional RFC 3161 timestamp authority (e.g. https://freetsa.org/tsr). When set, each
   * anchor also submits the head hash for an independent, signed timestamp token. Unset means
   * the file anchor is the only sink — recorded honestly as such, never faked.
   */
  AUDIT_TSA_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),

  /**
   * Consecutive feed polls a monitored shortage must be MISSING before the poll auto-resolves
   * its case (PHASE6 §6.6). Default 3: one miss is a feed flap, not a resolution, so a single
   * absent poll must never close a live shortage. An explicit `resolved` status from the feed
   * bypasses this and resolves immediately — the threshold only governs silent absence.
   */
  FEED_RESOLVE_MISS_THRESHOLD: z.coerce.number().int().positive().default(3),

  /**
   * Port for the worker's HTTP sidecar (PHASE6 §6.4): serves `/healthz`, `/readyz` (DB + Temporal),
   * and `/metrics` (Prometheus) so the worker — which has no web surface of its own — is scrapeable
   * and health-checkable. Defaults to 9464 (a commonly-unused exporter port); the compose
   * healthcheck and Prometheus scrape target both point here. Capped at 65535: a typo above the
   * TCP range would otherwise pass validation and kill the worker at bind time.
   */
  WORKER_HTTP_PORT: z.coerce.number().int().positive().max(65535).default(9464),

  /**
   * OIDC SSO / RBAC (PHASE6 §6.1). Every field defaults so the local gate and the public demo
   * run zero-config — but the stance mirrors comms: an UNSET secret is honest non-configuration,
   * never faked auth. `authConfigured()` below reports whether a real IdP session can be
   * established; when it cannot, the middleware still refuses console mutations (a request with
   * no session resolves to the anonymous `viewer`, which fails every `requireRole`), so a
   * deployment without an IdP is locked-down, not wide open.
   */
  AUTH_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
  /** Keycloak (or any OIDC IdP) realm issuer URL. Points at the compose Keycloak by default. */
  KEYCLOAK_ISSUER: z.string().default("http://localhost:8080/realms/stopgap"),
  /** OIDC client id registered in the realm. */
  KEYCLOAK_CLIENT_ID: z.string().default("stopgap-console"),
  /** OIDC client secret. Optional: a public client, or a deployment that has not wired auth. */
  KEYCLOAK_CLIENT_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Parse and cache process.env against the schema. */
export function getEnv(): Env {
  if (!cached) {
    cached = EnvSchema.parse(process.env);
  }
  return cached;
}

/**
 * Whether a real OIDC session can be established (PHASE6 §6.1). Needs both an `AUTH_SECRET`
 * (to sign the session JWT) and a Keycloak client secret. When false, the console runs in its
 * honest non-configured state: no one can sign in, so every request is the anonymous `viewer`
 * and all mutations are refused — locked-down, never a faked "authenticated" success.
 */
export function authConfigured(env: Env = getEnv()): boolean {
  return Boolean(env.AUTH_SECRET && env.KEYCLOAK_CLIENT_SECRET);
}

/** Test helper: reset the cache so a mutated process.env is re-read. */
export function resetEnvCache(): void {
  cached = undefined;
}
