import { z } from "zod";

/**
 * The response envelope every `/api/v1` route uses (PHASE6 §6.7).
 *
 * One module so an integrator can write ONE error handler: every failure — bad token, missing
 * scope, throttled, malformed body, unknown case — comes back as `{ error, message }` with a
 * machine-readable `error` code and a human `message`, and never as an HTML error page or a bare
 * status. That matters more for an API than for the console: a client that has to string-match a
 * rendered page to tell "you lack the scope" from "the case does not exist" will get it wrong.
 *
 * The `message` is deliberately allowed to be specific about POLICY (which scope was required,
 * what the hourly limit is) but never about SECRETS — see `api-auth.ts` for why an unknown key
 * and a revoked key produce the same body.
 */

/** Machine-readable error codes. Stable: clients branch on these, so a rename is a breaking change. */
export const API_ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "rate_limited",
  "invalid_request",
  "not_found",
  "conflict",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const apiErrorSchema = z.object({
  error: z.enum(API_ERROR_CODES),
  message: z.string(),
  /** Present only on `invalid_request`: the Zod issues, so a client can point at the bad field. */
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

/** A JSON success body with the standard headers. */
export function jsonOk(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** A JSON error body. `headers` carries the protocol bits (`WWW-Authenticate`, `Retry-After`). */
export function jsonError(
  status: number,
  error: ApiErrorCode,
  message: string,
  headers?: Record<string, string>,
): Response {
  return Response.json({ error, message } satisfies ApiError, { status, headers });
}

/**
 * Parse untrusted input, or return a 400 naming every bad field. Returned as a discriminated
 * result rather than thrown: a route that forgets a try/catch would otherwise turn a client's typo
 * into a 500, which tells the integrator "the server is broken" when the truth is "your body is".
 */
export function parseOr400<T extends z.ZodTypeAny>(
  schema: T,
  input: unknown,
): { ok: true; data: z.infer<T> } | { ok: false; response: Response } {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    response: Response.json(
      {
        error: "invalid_request",
        message: "request failed validation",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      } satisfies ApiError,
      { status: 400 },
    ),
  };
}

/** Read and parse a JSON request body, or return a 400 — a malformed body is the client's error. */
export async function parseJsonBodyOr400<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      ok: false,
      response: jsonError(400, "invalid_request", "request body is not valid JSON"),
    };
  }
  return parseOr400(schema, raw);
}
