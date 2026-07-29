import { describeViolations, screenContent, type ComplianceReport } from "@stopgap/compliance";
import { getEnv } from "@stopgap/core/env";

/**
 * Outbound comms (PROJECT_PLAN §5, §13 Phase 4): the approved protocol goes to the pharmacy
 * team by email and to the EHR as a formulary flag.
 *
 * Two rules shape this module:
 * - **Idempotency is the caller's key, not a timestamp.** Both channels take an
 *   `idempotencyKey` derived from the case, so a Temporal activity retry after a partial
 *   send does not page the pharmacy twice about the same shortage.
 * - **Absent credentials degrade to a recorded no-op, never a silent success.** A missing
 *   `RESEND_API_KEY` returns `delivered: false` with a reason, which the activity writes into
 *   the audit trail. A stub that reported success would make "we told the floor" unfalsifiable.
 * - **Nothing leaves without passing the compliance guard.** Send is the moment content leaves
 *   this system's control, so it is where the product's non-clinical boundary stops being a claim
 *   and becomes a check (ticket 10). A violating payload is a recorded non-delivery in exactly the
 *   same shape as a missing credential — same result type, same audit path, nothing special-cased.
 */

export interface CommsMessage {
  /** Stable per-case key; repeated sends with the same key must not duplicate. */
  idempotencyKey: string;
  subject: string;
  body: string;
  to: string[];
}

export interface CommsResult {
  channel: "email" | "ehr";
  delivered: boolean;
  /** Why a send did not happen (missing credentials, transport error). */
  reason?: string;
  /** Provider-side id when the transport returned one. */
  providerId?: string;
  /**
   * The guard's findings when this send was refused on content (ticket 10). Present ONLY on a
   * compliance block, so a caller can record what was objected to instead of discovering that a
   * message vanished. The excerpts live here and deliberately not in `reason`: a false positive is
   * only fixable if somebody can see the line that tripped it, and this field goes into the
   * tenant's own audit trail rather than into a log line or a metric label.
   */
  blocked?: ComplianceReport;
}

/**
 * Screen everything a payload would carry, as one report.
 *
 * The subject is screened alongside the body because it is content the recipient reads and the
 * transport stores, and a record number pasted into a subject line leaves the system just as
 * completely as one in the body. Concatenating for a single pass keeps one report per send, which
 * is what the audit entry wants.
 */
function screenOutbound(parts: readonly string[]): ComplianceReport {
  return screenContent(parts.filter((part) => part.length > 0).join("\n"));
}

/** The refusal, in the same shape every other non-delivery uses. */
function complianceBlock(channel: CommsResult["channel"], report: ComplianceReport): CommsResult {
  return {
    channel,
    delivered: false,
    reason: `blocked by compliance guard: ${describeViolations(report)}`,
    blocked: report,
  };
}

/** Send the protocol to the pharmacy distribution list via Resend. */
export async function sendEmail(message: CommsMessage): Promise<CommsResult> {
  // Content first, configuration second. A deployment with working credentials is precisely the
  // one that would deliver a violating message, so the guard cannot sit behind the credential
  // check — that would make the check pass only where it does not matter.
  const report = screenOutbound([message.subject, message.body]);
  if (!report.ok) return complianceBlock("email", report);

  const env = getEnv();
  const configured = env.COMMS_PHARMACY_TO.split(",")
    .map((address) => address.trim())
    .filter((address) => address.length > 0);
  const recipients =
    message.to.length > 0
      ? message.to
      : configured.length > 0
        ? configured
        : compact([env.COMMS_DEMO_INBOX]);
  if (!env.RESEND_API_KEY) {
    return { channel: "email", delivered: false, reason: "RESEND_API_KEY not configured" };
  }
  if (recipients.length === 0) {
    return { channel: "email", delivered: false, reason: "no recipients configured" };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
        // Resend deduplicates on this header, so a retried activity re-sends the same
        // request rather than a second email.
        "idempotency-key": message.idempotencyKey,
      },
      body: JSON.stringify({
        from: env.COMMS_FROM,
        to: recipients,
        subject: message.subject,
        text: message.body,
      }),
    });
    if (!response.ok) {
      return {
        channel: "email",
        delivered: false,
        reason: `resend responded ${String(response.status)}`,
      };
    }
    const payload = (await response.json()) as { id?: string };
    return { channel: "email", delivered: true, providerId: payload.id };
  } catch (err) {
    return { channel: "email", delivered: false, reason: errorMessage(err) };
  }
}

/** Flag the substitution in the EHR/formulary system via its inbound webhook. */
export async function sendEhrFlag(
  message: Pick<CommsMessage, "idempotencyKey" | "body"> & { key: string; alternatives: string[] },
): Promise<CommsResult> {
  // Every field that reaches the wire is screened, `key` included: it is serialised into the
  // outbound JSON like the rest, so screening only the prose would leave one field through. A
  // different transport is not a different boundary.
  const report = screenOutbound([message.key, message.body, ...message.alternatives]);
  if (!report.ok) return complianceBlock("ehr", report);

  const env = getEnv();
  try {
    const response = await fetch(env.EHR_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": message.idempotencyKey },
      body: JSON.stringify({
        key: message.key,
        alternatives: message.alternatives,
        protocol: message.body,
      }),
    });
    if (!response.ok) {
      return {
        channel: "ehr",
        delivered: false,
        reason: `ehr responded ${String(response.status)}`,
      };
    }
    return { channel: "ehr", delivered: true };
  } catch (err) {
    // The EHR webhook defaults to a localhost endpoint that does not exist in a dev
    // environment; an unreachable endpoint is a recorded non-delivery, not a case failure.
    return { channel: "ehr", delivered: false, reason: errorMessage(err) };
  }
}

function compact(values: (string | undefined)[]): string[] {
  return values.filter((value): value is string => Boolean(value));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
