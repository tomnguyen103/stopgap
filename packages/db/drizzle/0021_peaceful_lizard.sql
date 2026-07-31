-- Ticket 21 — composite tenant foreign keys.
--
-- HAND-ORDERED, and the order is the whole difficulty: `drizzle-kit` emitted every ADD CONSTRAINT
-- before the CREATE UNIQUE INDEX statements they target, and Postgres refuses a foreign key whose
-- referenced pair carries no unique constraint. Indexes first, then the keys.
--
-- Two keys are hand-written rather than generated. `ON DELETE SET NULL` on a composite nulls EVERY
-- referencing column, and `org_id` is NOT NULL — so the generated form would not have failed here,
-- it would have failed the first time somebody deleted a supplier or a site. Postgres 15+ takes an
-- explicit column list, which nulls only the part that should go. NOTE FOR ANYONE EDITING THOSE TWO
-- KEYS: `drizzle-kit push` builds from `schema.ts`, which cannot express the column list, so a
-- database built by `push` rather than by this migration gets the plain form and will throw 23502
-- on the first such delete. Migrate; do not push.
--
-- LOCKS. Fourteen ADD CONSTRAINTs each take ACCESS EXCLUSIVE on the child and scan it to validate,
-- and six unique indexes block writes while they build — all inside one transaction, so the
-- blocking is the SUM. On a large `procurement_events` this is real downtime, and it is why
-- `lock_timeout` is set rather than left to queue behind a long reader and stall every writer
-- behind it in turn. If it trips, run it in a maintenance window; do not raise the timeout.

SET lock_timeout = '10s';--> statement-breakpoint

do $$
declare bad text := '';
begin
  -- ROW SECURITY OFF, EXPLICITLY. Every table read below is FORCE ROW LEVEL SECURITY, and this
  -- session sets no `app.current_org` — so under a role that does not bypass RLS every policy is
  -- false, every count is zero, and this check would report a clean database no matter what it
  -- holds. Asking for it off makes a role that cannot do so fail here, loudly, instead.
  set local row_security = off;

    if (select count(*) from acknowledgments a join cases c on c.id = a.case_id where c.org_id <> a.org_id) > 0 then
      bad := bad || 'acknowledgments.case_id ';
    end if;
    if (select count(*) from audit_log l join cases c on c.id = l.case_id where c.org_id <> l.org_id) > 0 then
      bad := bad || 'audit_log.case_id ';
    end if;
    if (select count(*) from protocol_versions pv join protocols p on p.id = pv.protocol_id where p.org_id <> pv.org_id) > 0 then
      bad := bad || 'protocol_versions.protocol_id ';
    end if;
    if (select count(*) from protocol_versions pv join cases c on c.id = pv.source_case_id where c.org_id <> pv.org_id) > 0 then
      bad := bad || 'protocol_versions.source_case_id ';
    end if;
    if (select count(*) from item_identifiers i join items p on p.id = i.item_id where p.org_id <> i.org_id) > 0 then
      bad := bad || 'item_identifiers.item_id ';
    end if;
    if (select count(*) from supplier_sites ss join suppliers p on p.id = ss.supplier_id where p.org_id <> ss.org_id) > 0 then
      bad := bad || 'supplier_sites.supplier_id ';
    end if;
    if (select count(*) from item_suppliers x join items p on p.id = x.item_id where p.org_id <> x.org_id) > 0 then
      bad := bad || 'item_suppliers.item_id ';
    end if;
    if (select count(*) from item_suppliers x join suppliers p on p.id = x.supplier_id where p.org_id <> x.org_id) > 0 then
      bad := bad || 'item_suppliers.supplier_id ';
    end if;
    if (select count(*) from item_suppliers x join supplier_sites p on p.id = x.site_id where p.org_id <> x.org_id) > 0 then
      bad := bad || 'item_suppliers.site_id ';
    end if;
    if (select count(*) from inventory_snapshots v join facilities p on p.id = v.facility_id where p.org_id <> v.org_id) > 0 then
      bad := bad || 'inventory_snapshots.facility_id ';
    end if;
    if (select count(*) from inventory_snapshots v join items p on p.id = v.item_id where p.org_id <> v.org_id) > 0 then
      bad := bad || 'inventory_snapshots.item_id ';
    end if;
    if (select count(*) from procurement_events e join facilities p on p.id = e.facility_id where p.org_id <> e.org_id) > 0 then
      bad := bad || 'procurement_events.facility_id ';
    end if;
    if (select count(*) from procurement_events e join items p on p.id = e.item_id where p.org_id <> e.org_id) > 0 then
      bad := bad || 'procurement_events.item_id ';
    end if;
    if (select count(*) from procurement_events e join suppliers p on p.id = e.supplier_id where p.org_id <> e.org_id) > 0 then
      bad := bad || 'procurement_events.supplier_id ';
    end if;

  if bad <> '' then
    raise exception 'ticket 21: rows already name a parent in another tenant, in: %. These are exactly what the composite keys make impossible; decide what each row should have said before re-running.', bad;
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
ALTER TABLE "protocol_versions" DROP CONSTRAINT "protocol_versions_protocol_id_protocols_id_fk";
--> statement-breakpoint
ALTER TABLE "protocol_versions" DROP CONSTRAINT "protocol_versions_source_case_id_cases_id_fk";
--> statement-breakpoint
ALTER TABLE "supplier_sites" DROP CONSTRAINT "supplier_sites_supplier_id_suppliers_id_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX "cases_org_id_uq" ON "cases" USING btree ("org_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "facilities_org_id_uq" ON "facilities" USING btree ("org_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "items_org_id_uq" ON "items" USING btree ("org_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "protocols_org_id_uq" ON "protocols" USING btree ("org_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_sites_org_id_uq" ON "supplier_sites" USING btree ("org_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_org_id_uq" ON "suppliers" USING btree ("org_id","id");
--> statement-breakpoint
CREATE INDEX "item_suppliers_site_idx" ON "item_suppliers" USING btree ("org_id","site_id");
--> statement-breakpoint
CREATE INDEX "procurement_events_supplier_idx" ON "procurement_events" USING btree ("org_id","supplier_id");
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
ALTER TABLE "protocol_versions" ADD CONSTRAINT "protocol_versions_org_protocol_fk" FOREIGN KEY ("org_id","protocol_id") REFERENCES "public"."protocols"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "protocol_versions" ADD CONSTRAINT "protocol_versions_org_source_case_fk" FOREIGN KEY ("org_id","source_case_id") REFERENCES "public"."cases"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "supplier_sites" ADD CONSTRAINT "supplier_sites_org_supplier_fk" FOREIGN KEY ("org_id","supplier_id") REFERENCES "public"."suppliers"("org_id","id") ON DELETE cascade ON UPDATE no action;
