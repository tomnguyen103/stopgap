"use client";

import { useEffect } from "react";
import { Button } from "./ui/button";
import { Card } from "./ui/card";

/**
 * What a role sees when a view throws — most often a database that is not answering.
 *
 * Two things this says that Next's default page cannot. First, that nothing was written: a
 * pharmacist who has just clicked Approve and been thrown to an error page needs to know whether
 * their decision landed, and for a render failure the answer is always no. Second, the digest —
 * the only handle an operator can quote to find the matching server log, since the message itself
 * is deliberately not sent to the browser in production.
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
      <Card title="Nothing was changed">
        <p>
          The {surface} surface failed to render. Any decision you took before this is either
          already recorded or was never submitted — a failure here cannot leave one half-written.
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
