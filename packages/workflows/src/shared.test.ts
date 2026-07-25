import { describe, expect, it } from "vitest";
import { SEED_ORG_ID as DB_SEED_ORG_ID } from "@stopgap/db";
import type { ShortageRecord } from "@stopgap/core";
import {
  ORG_QUALIFIED_CASE_INPUT_PATCH,
  SEED_ORG_ID,
  resolveCaseOrgId,
  type CaseInput,
} from "./shared.js";

/**
 * THE DEPLOY-COMPATIBILITY CONTRACT for `CaseInput.orgId` (PHASE6 §6.5).
 *
 * `shortageCaseWorkflow` runs for up to 90 days (`MAX_MONITORING_MS`), so a deploy always lands
 * with executions in flight. Those started before multi-tenancy have an input in their history with
 * no `orgId` at all, and replaying them under code that reads the field unconditionally hands
 * `withOrgDb` `undefined` — which fails its uuid guard on every subsequent activity, breaking real
 * running cases at the moment a pharmacist next touches them.
 *
 * `resolveCaseOrgId` is the one place that is decided, and the branch is driven by Temporal's
 * `patched()` marker (durable history) rather than by whether the field happens to be present — so
 * a replay always takes the same branch it took the first time. These tests pin both eras without
 * having to construct a Temporal history.
 */

const record: ShortageRecord = {
  source: "openfda",
  sourceId: "0338-0431-03:Current",
  key: "heparin sodium",
  genericName: "Heparin Sodium Injection",
  status: "current",
  ndcs: ["0338-0431-03"],
  rxcuis: ["1658690"],
};

/** An input as a PRE-multi-tenancy execution's history holds it: no `orgId` key at all. */
function preMigrationInput(): CaseInput {
  return { record, sources: ["openfda"] } as unknown as CaseInput;
}

describe("resolveCaseOrgId", () => {
  it("uses the input's org for an execution started AFTER the patch", () => {
    const orgId = "bbbbbbbb-0000-0000-0000-0000000000b1";
    const input: CaseInput = { orgId, record, sources: ["openfda"] };
    expect(resolveCaseOrgId(input, true)).toBe(orgId);
  });

  it("falls back to the seed org for PRE-PATCH history that carries no org", () => {
    // Not a guess: migration 0013 backfilled every pre-existing row — including the `cases` row
    // each of these executions is tracking — into exactly this org.
    expect(resolveCaseOrgId(preMigrationInput(), false)).toBe(SEED_ORG_ID);
  });

  it("returns a real uuid for pre-patch history, so withOrgDb's guard passes", () => {
    // The whole failure this exists to prevent: `withOrgDb` rejects a non-uuid at the boundary, so
    // an `undefined` here would fail EVERY activity of a resumed pre-migration case.
    expect(resolveCaseOrgId(preMigrationInput(), false)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("does NOT fall back once patched — a missing org after this deploy is a caller bug", () => {
    // Silently resolving it to the seed tenant would write one hospital's clinical case into
    // another's chain; the loud uuid failure from `withOrgDb` is the better outcome.
    expect(resolveCaseOrgId(preMigrationInput(), true)).toBeUndefined();
  });
});

describe("the constants the compatibility path depends on", () => {
  it("mirrors SEED_ORG_ID from @stopgap/db exactly", () => {
    // The literal is duplicated because this module is bundled into Temporal's workflow sandbox and
    // `@stopgap/db` pulls in a Postgres driver. This assertion is what stops the copy drifting from
    // the value migration 0013 actually wrote.
    expect(SEED_ORG_ID).toBe(DB_SEED_ORG_ID);
  });

  it("pins the patch id, which is written into durable history and can never be renamed", () => {
    expect(ORG_QUALIFIED_CASE_INPUT_PATCH).toBe("org-qualified-case-input");
  });
});
