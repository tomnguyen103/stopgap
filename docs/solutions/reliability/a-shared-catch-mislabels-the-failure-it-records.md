# A shared `try` is free until something writes a STATUS from its `catch`

Found by the local review's spec and security axes on the same hunk, on the branch that
added per-tenant connector health (ticket 17). Nothing was broken before that branch; the
change is what turned a harmless imprecision into a false alarm.

## The shape

`pollAndOpenCases` contained one `try` per organization covering two different things:

```ts
try {
  await withOrgDb(org.id, async (db) => { /* signals, scores, evidence */ });
  // Outside the write transaction on purpose — these are network calls.
  await evaluateAndNotify(org.id, scoredForAlerts, pollTimestamp);
} catch (err) {
  incrementCounter("stopgap_signal_persist_failures_total");
  console.error(`[poll] signal persistence failed for org ${org.id}: …`);
}
```

That was fine for years. The catch produced a log line and a counter, and a log line that
says "persistence" when the real cause was SMTP is a diagnosis someone corrects in a
minute.

## What made it a defect

The connector-health work added a `persistError` variable set in that same catch, and
wrote it to a database column that an administrator reads:

```ts
if (persistError !== undefined) {
  return { source, outcome: "persist_failed", signalCount: 0, detail: persistError };
}
```

`sendChat` and `sendEmail` reject on a webhook timeout or an SMTP outage. Neither says
anything about whether a FEED delivered. So after a signal write that had **already
committed**, a mail outage wrote all four connectors as `persist_failed` with
`signalCount: 0` — four healthy feeds rendered as broken on the administrator's page, with
the mail server's error text under the table, on every tenant at once.

The ticket's criterion is "so a silent feed is noticed". The code inverted it into a loud
alarm about feeds that were fine.

## Two other instances of the same mistake, same hunk

- **Normalization was moved into the try** so the connector row could still see `signals`
  when the write failed. But normalization is pure and depends on the fetched payloads
  rather than on the tenant, so a normalizer that throws throws for *every* org. Containing
  it converted one poll-wide bug into a `persist_failed` row per tenant and a poll that
  still reported success — the loud failure made quiet. It belongs outside the containment;
  hoisting the declaration was never the reason it had to move.
- **A REQUIRED feed's fetch failure recorded nothing at all.** `fetchFeeds` rethrows for
  required feeds *before* the per-org loop, so an openFDA or ASHP outage — the exact case
  the panel exists for — wrote no row for anyone, and the panel showed the last good run
  until it aged into "quiet" 36 hours later.

## Fix

Split the containment along the boundary the STATUS field claims to describe, and give the
failure that is not about that field its own block:

```ts
let persistError: string | undefined;          // the tenant's own WRITE failing, nothing else
try { await withOrgDb(org.id, /* writes */); } catch (err) { persistError = …; }

await recordConnectorRuns(/* reflects the write only */);

if (persistError === undefined) {
  try { await evaluateAndNotify(…); } catch (err) { /* contained separately */ }
}
```

The `if` reproduces what the shared `try` did by construction — a throw from the write
skipped the notify — so behaviour is unchanged except in which failure gets named. The
alert block increments the **same** counter it always did: the split is about what the
status column says, not about moving the metrics.

## The general rule

Contained failures are cheap to over-scope while the `catch` only logs. The moment
something in that `catch` writes a value a human will READ AS A DIAGNOSIS — a status
column, a health badge, a stored reason — the `try` has to be narrowed to exactly the
operation that value describes.

Ask it directly: **for every statement inside this `try`, is the thing I record in the
`catch` a true statement about it?** Here it was true of one statement and false of the
other, and the false one ran second, so it was also the likelier to fail.
