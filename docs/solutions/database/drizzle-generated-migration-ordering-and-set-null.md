# Two ways `drizzle-kit generate` produced a migration that could not run

Both hit while adding composite `(org_id, id)` tenant foreign keys (ticket 21). Both were
found by reading the generated SQL, not by running it — which is the point.

## 1. Constraints emitted before the indexes they target

`drizzle-kit` emitted all twelve `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY
("org_id","case_id") REFERENCES ...("org_id","id")` statements **before** the
`CREATE UNIQUE INDEX ..._org_id_uq` statements those keys reference.

Postgres refuses a foreign key whose referenced column pair carries no unique constraint,
so the migration fails on its first statement, every time, on every database.

**Fix.** Reorder by hand: drops, then unique indexes, then the keys. The generator has no
notion that one of its outputs is a precondition for another.

## 2. `ON DELETE SET NULL` on a composite key nulls *every* referencing column

Two of the keys were `ON DELETE SET NULL` (`item_suppliers.site_id`,
`procurement_events.supplier_id`). Drizzle's `.onDelete("set null")` emits the plain form,
which on a composite key sets **all** referencing columns to NULL — including `org_id`,
which is `NOT NULL`.

This is the dangerous one: the migration **applies cleanly**. It fails later, the first
time somebody deletes a supplier or a site, with a `23502` in production.

**Fix.** Postgres 15+ takes an explicit column list — `ON DELETE SET NULL ("site_id")` —
hand-written over the generated DDL, the same way the RLS policies are re-applied.

**Caveat that comes with it.** `schema.ts` cannot express the column list, so the schema
model and the migration now disagree. `drizzle-kit push` builds from the schema and
produces the plain form, so a database built by `push` rather than by the migrations will
throw on the first such delete. Migrate; do not push. This is noted in the migration header
and beside both keys in `schema.ts`.

**The general rule.** Generated DDL is a draft. Read it before trusting it — especially
statement ORDER, and any clause where the generator cannot express what the schema means.
A migration that applies cleanly is not the same as a migration that is correct.
