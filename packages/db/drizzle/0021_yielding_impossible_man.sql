-- Ticket 21 — composite tenant foreign keys.
--
-- HAND-ORDERED, and the order is the whole difficulty: `drizzle-kit` emitted every ADD CONSTRAINT
-- before the CREATE UNIQUE INDEX statements they target, and Postgres refuses a foreign key whose
-- referenced pair carries no unique constraint. Indexes first, then the keys.
--
-- Two keys are hand-written rather than generated. `ON DELETE SET NULL` on a composite nulls EVERY
-- referencing column, and `org_id` is NOT NULL — so the generated form would have thrown the first
-- time somebody deleted a supplier or a site, long after the migration reported success. Postgres
-- 15+ takes an explicit column list, which nulls only the part that should go.
--
-- Applies against existing data. The pre-flight below refuses rather than silently dropping a row
-- whose org and whose parent already disagree: on this deployment it found none, but a database
-- that has been running longer is exactly where one would be, and a migration that discovers a
-- violation should say so rather than fail with a bare constraint error.

do $$
declare offending bigint;
begin
  select
    (select count(*) from acknowledgments a join cases c on c.id = a.case_id where c.org_id <> a.org_id)
  + (select count(*) from audit_log l join cases c on c.id = l.case_id where c.org_id <> l.org_id)
  + (select count(*) from item_identifiers i join items p on p.id = i.item_id where p.org_id <> i.org_id)
  + (select count(*) from supplier_sites s join suppliers p on p.id = s.supplier_id where p.org_id <> s.org_id)
  + (select count(*) from item_suppliers x join items p on p.id = x.item_id where p.org_id <> x.org_id)
  + (select count(*) from item_suppliers x join suppliers p on p.id = x.supplier_id where p.org_id <> x.org_id)
  + (select count(*) from item_suppliers x join supplier_sites p on p.id = x.site_id where p.org_id <> x.org_id)
  + (select count(*) from inventory_snapshots v join facilities p on p.id = v.facility_id where p.org_id <> v.org_id)
  + (select count(*) from inventory_snapshots v join items p on p.id = v.item_id where p.org_id <> v.org_id)
  + (select count(*) from procurement_events e join facilities p on p.id = e.facility_id where p.org_id <> e.org_id)
  + (select count(*) from procurement_events e join items p on p.id = e.item_id where p.org_id <> e.org_id)
  + (select count(*) from procurement_events e join suppliers p on p.id = e.supplier_id where p.org_id <> e.org_id)
  into offending;

  if offending > 0 then
    raise exception 'ticket 21: % row(s) already name a parent in another tenant. These are the rows the composite keys exist to make impossible; decide what each one should have said before re-running.', offending;
  end if;
end $$;
--> statement-breakpoint
ALTER TABLE "acknowledgments" DROP CONSTRAINT "acknowledgments_case_id_cases_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_case_id_cases_id_fk";
--> statement-breakpoint
ALTER TABLE "inventory_snapshots" DROP CONSTRAINT "inventory_snapshots_facility_id_facilities_id_fk";
--> statement-breakpoint
ALTER TABLE "inventory_snapshots" DROP CONSTRAINT "inventory_snapshots_item_id_items_id_fk";
--> statement-breakpoint
ALTER TABLE "item_identifiers" DROP CONSTRAINT "item_identifiers_item_id_items_id_fk";
--> statement-breakpoint
ALTER TABLE "item_suppliers" DROP CONSTRAINT "item_suppliers_item_id_items_id_fk";
--> statement-breakpoint
ALTER TABLE "item_suppliers" DROP CONSTRAINT "item_suppliers_supplier_id_suppliers_id_fk";
--> statement-breakpoint
ALTER TABLE "item_suppliers" DROP CONSTRAINT "item_suppliers_site_id_supplier_sites_id_fk";
--> statement-breakpoint
ALTER TABLE "procurement_events" DROP CONSTRAINT "procurement_events_facility_id_facilities_id_fk";
--> statement-breakpoint
ALTER TABLE "procurement_events" DROP CONSTRAINT "procurement_events_item_id_items_id_fk";
--> statement-breakpoint
ALTER TABLE "procurement_events" DROP CONSTRAINT "procurement_events_supplier_id_suppliers_id_fk";
--> statement-breakpoint
ALTER TABLE "supplier_sites" DROP CONSTRAINT "supplier_sites_supplier_id_suppliers_id_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX "cases_org_id_uq" ON "cases" USING btree ("org_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "facilities_org_id_uq" ON "facilities" USING btree ("org_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "items_org_id_uq" ON "items" USING btree ("org_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_sites_org_id_uq" ON "supplier_sites" USING btree ("org_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_org_id_uq" ON "suppliers" USING btree ("org_id","id");
--> statement-breakpoint
ALTER TABLE "acknowledgments" ADD CONSTRAINT "acknowledgments_org_case_fk" FOREIGN KEY ("org_id","case_id") REFERENCES "public"."cases"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_case_fk" FOREIGN KEY ("org_id","case_id") REFERENCES "public"."cases"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ADD CONSTRAINT "inventory_snapshots_org_facility_fk" FOREIGN KEY ("org_id","facility_id") REFERENCES "public"."facilities"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ADD CONSTRAINT "inventory_snapshots_org_item_fk" FOREIGN KEY ("org_id","item_id") REFERENCES "public"."items"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_identifiers" ADD CONSTRAINT "item_identifiers_org_item_fk" FOREIGN KEY ("org_id","item_id") REFERENCES "public"."items"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_suppliers" ADD CONSTRAINT "item_suppliers_org_item_fk" FOREIGN KEY ("org_id","item_id") REFERENCES "public"."items"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_suppliers" ADD CONSTRAINT "item_suppliers_org_supplier_fk" FOREIGN KEY ("org_id","supplier_id") REFERENCES "public"."suppliers"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_suppliers" ADD CONSTRAINT "item_suppliers_org_site_fk" FOREIGN KEY ("org_id","site_id") REFERENCES "public"."supplier_sites"("org_id","id") ON DELETE SET NULL ("site_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "procurement_events" ADD CONSTRAINT "procurement_events_org_facility_fk" FOREIGN KEY ("org_id","facility_id") REFERENCES "public"."facilities"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "procurement_events" ADD CONSTRAINT "procurement_events_org_item_fk" FOREIGN KEY ("org_id","item_id") REFERENCES "public"."items"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "procurement_events" ADD CONSTRAINT "procurement_events_org_supplier_fk" FOREIGN KEY ("org_id","supplier_id") REFERENCES "public"."suppliers"("org_id","id") ON DELETE SET NULL ("supplier_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "supplier_sites" ADD CONSTRAINT "supplier_sites_org_supplier_fk" FOREIGN KEY ("org_id","supplier_id") REFERENCES "public"."suppliers"("org_id","id") ON DELETE cascade ON UPDATE no action;
