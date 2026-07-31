import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "./client.js";
import { withOrgDb } from "./org-context.js";
import { listUsers, setUserDisabled } from "./users.js";

/**
 * Disabling an account was a one-way door.
 *
 * `setUserDisabled` has always taken a boolean and re-enables correctly, but `listUsers` filtered
 * every disabled row out, and the console's only caller passed `true`. So an admin who disabled the
 * wrong account could not see it, could not select it, and could not undo it — recovery meant
 * someone with database credentials writing an `update` by hand, in a product whose whole claim is
 * that privileged actions are auditable through the application.
 *
 * WHY NOT OFFLINE: the bug is in a `where` clause. A fake would assert that `listUsers` was called,
 * which is exactly the thing that was never wrong.
 *
 *   DATABASE_URL=postgres://stopgap_app:stopgap_app@localhost:5433/stopgap pnpm test:rls
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://stopgap_app:stopgap_app@localhost:5433/stopgap";

const ORG = "aaaaaaaa-0000-0000-0000-00000000009b";
const SUBJECT = "users-e2e-subject";

const raw = postgres(DATABASE_URL, { max: 2, onnotice: () => undefined });

beforeAll(async () => {
  await raw`insert into organizations (id, slug, name)
            values (${ORG}, 'users-e2e', 'users-e2e') on conflict (id) do nothing`;
  await raw.begin(async (tx) => {
    await tx`select set_config('app.current_org', ${ORG}, true)`;
    await tx`delete from users where org_id = ${ORG}`;
    await tx`insert into users (org_id, oidc_subject, email, display_name)
             values (${ORG}, ${SUBJECT}, 'users-e2e@example.test', 'Users E2E')`;
  });
});

afterAll(async () => {
  await raw.begin(async (tx) => {
    await tx`select set_config('app.current_org', ${ORG}, true)`;
    await tx`delete from users where org_id = ${ORG}`;
  });
  await raw`delete from organizations where id = ${ORG}`;
  await raw.end({ timeout: 5 });
  await closeDb();
});

async function only(includeDisabled: boolean) {
  return withOrgDb(ORG, (db) => listUsers(ORG, db, { includeDisabled }));
}

describe("disabling and re-enabling an account", () => {
  it("hides a disabled account from the default list", async () => {
    const [user] = await only(false);
    expect(user).toBeDefined();
    await withOrgDb(ORG, (db) => setUserDisabled(ORG, user!.id, true, db));
    expect(await only(false)).toEqual([]);
  });

  it("still returns it when the caller asks to see disabled accounts", async () => {
    // The whole fix: without this the row exists and nothing in the product can name it.
    const rows = await only(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.disabledAt).toBeInstanceOf(Date);
  });

  it("re-enables it, and it returns to the default list", async () => {
    const [user] = await only(true);
    expect(await withOrgDb(ORG, (db) => setUserDisabled(ORG, user!.id, false, db))).toBe(true);
    const active = await only(false);
    expect(active).toHaveLength(1);
    expect(active[0]?.disabledAt).toBeNull();
  });

  it("reports no change when the account is already in the requested state", async () => {
    // The audit entry is written only on a real flip, so this boolean is what stops the chain
    // recording a privilege change that did not happen.
    const [user] = await only(false);
    expect(await withOrgDb(ORG, (db) => setUserDisabled(ORG, user!.id, false, db))).toBe(false);
  });
});
