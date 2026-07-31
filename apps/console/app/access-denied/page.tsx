import { Card } from "../components/ui";

/**
 * Where a caller the IdP authenticated but granted no recognized Stopgap role lands.
 *
 * OUTSIDE EVERY DASHBOARD GROUP, and that is the whole point: the group guard refuses such a caller,
 * so any destination inside a group would bounce them straight back here and loop. It has no group
 * layout, no nav, and no guard of its own to run.
 *
 * READS NOTHING. No principal, no org, no tenant query — the one situation this page exists for is
 * the one where we cannot say which tenant the caller belongs to, so it says only what is true for
 * everyone who reaches it, and names the fix in the terms an administrator can act on. Reading
 * nothing is also why it carries no `force-dynamic`: there is nothing per-request to opt out of.
 */
export default function AccessDeniedPage() {
  return (
    /* Prose measure (§5.2): this page is read, not scanned. */
    <main className="shell__main ds-prose">
      <h1>Access denied</h1>
      <Card title="No Stopgap role is assigned to this account">
        <p>
          You are signed in, but this account carries no role that Stopgap recognizes, so there is
          no dashboard to send you to.
        </p>
        <p>
          Ask an administrator to grant the account a role in the identity provider. If roles were
          granted recently, sign out and back in — roles are read from the session, and an existing
          session still carries the claims it was issued with.
        </p>
      </Card>
    </main>
  );
}
