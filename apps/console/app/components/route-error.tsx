"use client";

import { useEffect } from "react";
import { Button } from "./ui/button";
import { Card } from "./ui/card";

/**
 * What a role sees when a view throws — most often a database that is not answering.
 *
 * Two things this says that Next's default page cannot. First, WHERE TO LOOK. The tempting copy
 * is "nothing was changed", and it would be a lie: `reviewCase` and `resolveExceptionCase` signal
 * Temporal before their activities persist, and `approveProtocolVersionAction` commits before it
 * revalidates — so a render failure can follow a decision that is already recorded or still in
 * flight. A pharmacist who resubmits on the strength of a false reassurance is the failure mode
 * this page exists to prevent, so it names the two places the truth is written down instead.
 * Second, the digest — the only handle an operator can quote to find the matching server log,
 * since the message itself is deliberately not sent to the browser in production.
 *
 * `reset()` re-renders the segment. It is a real retry, not a page reload, so a transient outage
 * recovers without losing the rest of the shell.
 */
export function RouteError({
  error,
  reset,
  surface,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  surface: string;
}) {
  useEffect(() => {
    // The server already logged this with its stack. Repeating it here is what makes the digest
    // on screen findable from a browser console during an incident.
    console.error(`[${surface}]`, error);
  }, [error, surface]);

  return (
    <main>
      <h1>This view could not load</h1>
      <Card title="Check before you resubmit">
        <p>
          The {surface} surface failed to render. If you had just submitted a decision, this page
          cannot tell you whether it landed: a review signal reaches the workflow, and a protocol
          approval commits, before this view renders. Read the case&apos;s audit trail or the
          protocol&apos;s version history before submitting it again.
        </p>
        {error.digest ? (
          <p className="sub">
            Quote this reference to an administrator: <span className="mono">{error.digest}</span>
          </p>
        ) : null}
        <div className="actions">
          <Button type="button" onClick={reset}>
            Try again
          </Button>
        </div>
      </Card>
    </main>
  );
}
