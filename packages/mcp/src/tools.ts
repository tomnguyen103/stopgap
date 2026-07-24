import { getEnv } from "@stopgap/core/env";
import { z } from "zod";

/**
 * The pipeline tools an MCP client (Claude, an internal agent, a CLI) can call against a running
 * Stopgap (PROJECT_PLAN §4, refactored in PHASE6 §6.7).
 *
 * WHAT CHANGED AND WHY. This module used to import `@stopgap/db` and `@stopgap/workflows` and talk
 * to Postgres and Temporal directly, with its own ad-hoc gate (`STOPGAP_MCP_ALLOW_REVIEW=1`) in
 * front of its one mutation. That meant two authorization systems for the same platform: the
 * console's roles, and an env var. Two systems means the weaker one is the real one — anybody who
 * could set an env var on the MCP host could approve clinical guidance, and the audit chain would
 * record it as a decision by "mcp-client" with no credential behind the name.
 *
 * Now every tool is an HTTP call to the public REST API carrying a scoped API key. There is ONE
 * authorization path for all programmatic access: the key's scopes. The env gate is gone, because
 * "may this client write?" is answered by whether an administrator ticked `protocols:write` when
 * issuing the key — a decision made in the console, recorded in the audit chain, and revocable.
 *
 * The tool SET is unchanged by that refactor. Changing how a client authorizes and changing what it
 * can do are different decisions, and only the first was asked for; `review_case` therefore still
 * exists, now backed by `POST /api/v1/cases/{key}/review` instead of a direct Temporal signal.
 *
 * HONEST NON-CONFIGURATION. With `STOPGAP_API_KEY` unset, every tool returns a structured
 * `{ configured: false, message }` explaining how to issue a key. It does not fabricate data, and
 * it does NOT fall back to reading the database — the direct path is the thing this refactor
 * removed, and leaving it as a fallback would mean the "one authorization path" claim is false
 * exactly when it matters.
 */

/** The shape every tool returns when this MCP server has no credential to act with. */
export interface NotConfigured {
  configured: false;
  message: string;
}

const NOT_CONFIGURED_MESSAGE =
  "This MCP server is not configured. It now reaches Stopgap through the public REST API and " +
  "requires an API key: set STOPGAP_API_KEY (and STOPGAP_API_BASE_URL if the console is not at " +
  "http://localhost:3000). Issue a key from the console's /admin/api-keys page as an admin, " +
  "ticking the scopes each tool needs — cases:read, protocols:read, protocols:write, shadow:read. " +
  "The key's plaintext is shown once at issue time. No key means no access: there is deliberately " +
  "no direct-database fallback.";

/**
 * How long a single API call may hang before it is abandoned. Ten seconds: long enough for a cold
 * Next.js route to compile in dev, short enough that a wedged console surfaces as an error the
 * model can report rather than a tool call that never returns.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** The shape every tool returns when the API refused or failed the request. */
export interface ApiFailure {
  ok: false;
  status: number;
  error: string;
  message: string;
}

/** Whether this MCP server holds a credential at all — drives the tool descriptions in `server.ts`. */
export function apiConfigured(): boolean {
  return Boolean(getEnv().STOPGAP_API_KEY);
}

function notConfigured(): NotConfigured {
  return { configured: false, message: NOT_CONFIGURED_MESSAGE };
}

/**
 * Call the REST API with the configured key.
 *
 * Returns the not-configured marker rather than throwing when no key is set, and a structured
 * failure rather than throwing on a non-2xx: an MCP client renders a tool result to a model, and a
 * thrown transport error becomes an opaque string the model cannot reason about. A 403 that says
 * "this key does not carry the protocols:write scope" is actionable; "fetch failed" is not.
 */
async function callApi(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<unknown | NotConfigured | ApiFailure> {
  const env = getEnv();
  if (!env.STOPGAP_API_KEY) return notConfigured();

  // The non-2xx path below is not the only way this call fails. A stopped console, a wrong
  // STOPGAP_API_BASE_URL, or a hung connection never produces a Response at all — and an
  // unhandled throw here reaches the MCP client as an opaque transport string, the exact outcome
  // the contract above promises to avoid. The timeout matters for the same reason: an MCP client
  // has no way to cancel a tool call, so an unresponsive console would hang the session forever
  // rather than telling the model something it can act on.
  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    response = await fetch(new URL(path, env.STOPGAP_API_BASE_URL), {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${env.STOPGAP_API_KEY}`,
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
  } catch (err) {
    // `status: 0` — no HTTP exchange happened, so claiming any status code would be a fabrication.
    return {
      ok: false,
      status: 0,
      error: "request_failed",
      message:
        err instanceof Error
          ? `could not reach the Stopgap API at ${env.STOPGAP_API_BASE_URL}: ${err.message}`
          : `could not reach the Stopgap API at ${env.STOPGAP_API_BASE_URL}`,
    };
  } finally {
    clearTimeout(timer);
  }

  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const body = (payload ?? {}) as { error?: string; message?: string };
    return {
      ok: false,
      status: response.status,
      error: body.error ?? "request_failed",
      message: body.message ?? `the Stopgap API returned ${response.status}`,
    };
  }
  return payload;
}

export const listCasesInput = z.object({
  limit: z.number().int().min(1).max(200).default(50),
});

/** Recent cases. Needs the `cases:read` scope. */
export async function listCasesTool(input: z.infer<typeof listCasesInput>): Promise<unknown> {
  return callApi(`/api/v1/cases?limit=${input.limit}`);
}

export const caseInput = z.object({ key: z.string().min(1) });

/**
 * One case by dedup key. Needs `cases:read`.
 *
 * Returns the DURABLE record only. Before §6.7 this tool folded in live workflow state (the draft
 * text and proposed alternatives held in the running Temporal workflow); the REST endpoint behind
 * it deliberately does not, so that the API's availability does not track the worker's. The tool
 * description says so rather than leaving a client to notice the fields silently missing.
 */
export async function getCaseTool(input: z.infer<typeof caseInput>): Promise<unknown> {
  return callApi(`/api/v1/cases/${encodeURIComponent(input.key)}`);
}

/** The approved protocol for a drug plus its version history. Needs `protocols:read`. */
export async function getProtocolTool(input: z.infer<typeof caseInput>): Promise<unknown> {
  return callApi(`/api/v1/protocols/${encodeURIComponent(input.key)}`);
}

export const shadowStatsInput = z.object({});

/** Shadow-mode agreement aggregates per drug class. Needs `shadow:read`. */
export async function getShadowStatsTool(): Promise<unknown> {
  return callApi("/api/v1/shadow/stats");
}

export const resolveExceptionInput = z.object({
  key: z.string().min(1),
  protocolBody: z.string().min(1),
  alternatives: z.array(z.string().min(1)).default([]),
  rationale: z.string().min(1),
});

/**
 * Resolve a case blocked at the exception gate. Needs `protocols:write`.
 *
 * Like `review_case` below, this used to reach Temporal directly behind the `STOPGAP_MCP_ALLOW_REVIEW`
 * env gate. That gate is gone: a key without `protocols:write` gets a 403 from the server, which is
 * an authorization decision an administrator made and can revoke, not an env var on whatever machine
 * happens to run this process.
 */
export async function resolveExceptionTool(input: z.infer<typeof resolveExceptionInput>): Promise<unknown> {
  const { key, ...body } = input;
  return callApi(`/api/v1/cases/${encodeURIComponent(key)}/resolve-exception`, {
    method: "POST",
    body,
  });
}

/**
 * The review decision, as a FLAT object.
 *
 * The wire format is a discriminated union (`{ kind: "edit", editedDraft }` etc.), but the MCP SDK
 * takes `inputSchema` as a ZodObject's `.shape`, so a top-level union cannot be declared here. The
 * flat shape is therefore the tool's surface, `reviewCaseTool` assembles the union from it, and the
 * server validates the result — which is the right place for that check anyway: the API is the
 * authority on its own body, and duplicating the constraint here would create a second definition
 * free to drift from it. A missing `editedDraft` on an edit comes back as a structured 400 naming
 * the field, which is information the model can act on.
 */
export const reviewCaseInput = z.object({
  key: z.string().min(1),
  kind: z.enum(["approve", "edit", "reject"]),
  /** Required when `kind` is `edit` — the corrected protocol text to adopt instead of the draft. */
  editedDraft: z.string().min(1).optional(),
  /** Required when `kind` is `reject` — why the draft was refused. */
  reason: z.string().min(1).optional(),
});

/**
 * Record the human-in-the-loop review decision on a case's drafted protocol. Needs `protocols:write`.
 *
 * This tool is BACK after §6.7, not gone. The refactor onto the REST API was supposed to unify how
 * programmatic clients authorize, not to remove what they can do — and review is the capability this
 * MCP server has exposed since PROJECT_PLAN §4. It is now backed by
 * `POST /api/v1/cases/{key}/review`, so the decision runs the same scope check, the same demo gate,
 * and lands in the same audit chain as every other write, attributed to the key and the human who
 * issued it.
 */
export async function reviewCaseTool(input: z.infer<typeof reviewCaseInput>): Promise<unknown> {
  const { key, kind, editedDraft, reason } = input;
  const decision =
    kind === "edit" ? { kind, editedDraft } : kind === "reject" ? { kind, reason } : { kind };
  return callApi(`/api/v1/cases/${encodeURIComponent(key)}/review`, { method: "POST", body: decision });
}
