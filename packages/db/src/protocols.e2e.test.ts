import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "./client.js";
import { withOrgDb } from "./org-context.js";
import {
  approveProtocolVersion,
  draftProtocolVersion,
  getApprovedProtocol,
  supersedeProtocolVersion,
} from "./protocols.js";

/**
 * The protocol state machine, against a live Postgres (ticket 14).
 *
 * WHY NOT OFFLINE: every transition here is a transaction with a row lock, and the invariant that
 * matters — a protocol has at most one approved version, ever — is enforced by what those
 * statements do to each other. A fake would assert the calls, not the guarantee.
 *
 *   DATABASE_URL=postgres://stopgap_app:stopgap_app@localhost:5433/stopgap pnpm test:rls
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://stopgap_app:stopgap_app@localhost:5433/stopgap";

const ORG = "aaaaaaaa-0000-0000-0000-00000000009a";
const KEY = "protocols-e2e-heparin";

const raw = postgres(DATABASE_URL, { max: 2, onnotice: () => undefined });

beforeAll(async () => {
  await raw`insert into organizations (id, slug, name)
            values (${ORG}, 'protocols-e2e', 'protocols-e2e') on conflict (id) do nothing`;
});

afterAll(async () => {
  await raw.begin(async (tx) => {
    await tx`select set_config('app.current_org', ${ORG}, true)`;
    await tx`delete from protocol_versions where org_id = ${ORG}`;
    await tx`delete from protocols where org_id = ${ORG}`;
  });
  await raw`delete from organizations where id = ${ORG}`;
  await raw.end({ timeout: 5 });
  await closeDb();
});

/** A fresh drafted version of the one fixture protocol. */
async function draft(body: string) {
  return withOrgDb(ORG, (db) =>
    draftProtocolVersion(
      { orgId: ORG, key: KEY, title: "Heparin conservation", body, alternatives: [], authoredBy: "agent" },
      db,
    ),
  );
}

describe("withdrawing the approved version", () => {
  it("leaves the protocol with NO approved version, rather than reviving an older one", async () => {
    // The whole point of the action. Approving supersedes the previous version on the way past, so
    // the protocol always has guidance; withdrawing leaves it with none — which is the honest state
    // when what was published turns out to be wrong and the replacement is not written yet.
    // Reviving v1 here would silently republish advice a director had already replaced.
    const v1 = await draft("first");
    await withOrgDb(ORG, (db) => approveProtocolVersion(ORG, v1.id, "director-a", null, db));
    const v2 = await draft("second");
    await withOrgDb(ORG, (db) => approveProtocolVersion(ORG, v2.id, "director-a", null, db));

    // Read INSIDE the tenant scope. A connection that has been scoped and released reverts
    // `app.current_org` to the empty string rather than to nothing, and the policy then refuses the
    // read outright — the fail-closed behaviour `rls.e2e.test.ts` pins.
    const live = await withOrgDb(ORG, (db) => getApprovedProtocol(ORG, KEY, db));
    expect(live?.version.id).toBe(v2.id);

    const result = await withOrgDb(ORG, (db) =>
      supersedeProtocolVersion(ORG, v2.id, "director-b", null, db),
    );
    expect(result.changed).toBe(true);
    expect(result.row.state).toBe("superseded");
    expect(await withOrgDb(ORG, (db) => getApprovedProtocol(ORG, KEY, db))).toBeUndefined();
  });

  it("records who withdrew it", async () => {
    // A withdrawal with no attribution is the one decision here nobody could later be asked to
    // explain.
    const v = await draft("third");
    await withOrgDb(ORG, (db) => approveProtocolVersion(ORG, v.id, "director-a", null, db));
    const result = await withOrgDb(ORG, (db) =>
      supersedeProtocolVersion(ORG, v.id, "director-b", null, db),
    );
    expect(result.row.approvedBy).toBe("director-b");
  });

  it("is idempotent, so a double-click is not a second withdrawal", async () => {
    const v = await draft("fourth");
    await withOrgDb(ORG, (db) => approveProtocolVersion(ORG, v.id, "director-a", null, db));
    await withOrgDb(ORG, (db) => supersedeProtocolVersion(ORG, v.id, "director-b", null, db));
    const again = await withOrgDb(ORG, (db) =>
      supersedeProtocolVersion(ORG, v.id, "director-b", null, db),
    );
    expect(again.changed).toBe(false);
  });

  it("refuses a draft, which has never been guidance", async () => {
    // Marking a draft superseded would take it out of the approval queue by giving it the state of
    // something that had once been live — an unreviewed draft quietly disappearing.
    const v = await draft("fifth");
    await expect(
      withOrgDb(ORG, (db) => supersedeProtocolVersion(ORG, v.id, "director-b", null, db)),
    ).rejects.toThrow(/not approved guidance/);
  });

  it("refuses a version that does not exist", async () => {
    await expect(
      withOrgDb(ORG, (db) =>
        supersedeProtocolVersion(ORG, "11111111-2222-3333-4444-555555555555", "d", null, db),
      ),
    ).rejects.toThrow(/not found/);
  });
});
