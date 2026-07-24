import "server-only";
import { withTemporalClient } from "@stopgap/workflows";
import { jsonError } from "./api-response";

/**
 * Signalling Temporal from an `/api/v1` write, with transport failure translated into the response
 * envelope (PHASE6 §6.7).
 *
 * Every write endpoint here signals a durable workflow rather than writing case state directly, and
 * that signal can fail for reasons that are ordinary rather than exceptional: the worker is stopped
 * or restarting, the Temporal frontend is unreachable, or the case's workflow has already completed
 * so there is no execution left to signal. Left unguarded, each of those surfaces as an unhandled
 * throw and Next answers 500 with an HTML error page — the exact opaque degradation the routes'
 * own headers argue against, and a status code that tells an integrator "this server is broken"
 * when the truth is "this platform's workflow engine is down, retry in a moment".
 *
 * So: 503 with the `conflict` code and a message that NAMES Temporal. 503 because the condition is
 * a dependency being unavailable and is retryable; naming Temporal because an operator reading an
 * integration's logs needs to know which component to go look at, and "the write failed" does not
 * tell them.
 *
 * NO FAKE SUCCESS. The failure path returns a refusal, never a 202. A route that swallowed the
 * error and reported the write as accepted would tell a pharmacy's integration that clinical
 * guidance had been recorded when the signal never landed — worse than any error code, because the
 * caller stops retrying.
 *
 * The underlying error is deliberately not echoed into the body: it is a gRPC transport string that
 * can carry internal addresses, and it is already available to the operator in the server logs.
 */
export async function signalTemporalOr503<T>(
  fn: Parameters<typeof withTemporalClient<T>>[0],
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  try {
    return { ok: true, value: await withTemporalClient(fn) };
  } catch (err) {
    console.error("[api] temporal signal failed", err);
    return {
      ok: false,
      response: jsonError(
        503,
        "conflict",
        "the write was NOT applied: Stopgap could not reach Temporal to signal the case's durable " +
          "workflow (the worker may be stopped, or this case's workflow may have already completed). " +
          "Nothing was recorded — retry once the workflow engine is available.",
        { "Retry-After": "30" },
      ),
    };
  }
}
