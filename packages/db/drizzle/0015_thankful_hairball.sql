-- Ticket 15 — the facility catalog: items, their identifiers, suppliers and sites, item-supplier
-- links, facilities, inventory snapshots and procurement events.
--
-- Table DDL is `drizzle-kit generate` output. The row-level security block at the bottom is
-- HAND-ADDED, for the reason 0013 gave: drizzle can express columns, indexes and foreign keys, and
-- cannot express a policy. A new tenant table without a policy is not a missing feature — it is a
-- table any authenticated tenant can read in full, which is why the isolation suite asserts every
-- one of these by name rather than trusting that the block below stayed in step with the schema.
--
-- Purely additive: eight new tables, no existing column, index or row is touched.

CREATE TABLE "facilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text
);
--> statement-breakpoint
CREATE TABLE "inventory_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"on_hand" numeric(14, 3) NOT NULL,
	"unit" text,
	"captured_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_identifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"type" text NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"site_id" uuid,
	"contract_price" numeric(14, 4),
	"preferred" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"generic_name" text,
	"unit" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "procurement_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"supplier_id" uuid,
	"ordered_at" timestamp with time zone NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_cost" numeric(14, 4)
);
--> statement-breakpoint
CREATE TABLE "supplier_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text,
	"country" text,
	"lead_time_days" integer
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ADD CONSTRAINT "inventory_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ADD CONSTRAINT "inventory_snapshots_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ADD CONSTRAINT "inventory_snapshots_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_identifiers" ADD CONSTRAINT "item_identifiers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_identifiers" ADD CONSTRAINT "item_identifiers_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_suppliers" ADD CONSTRAINT "item_suppliers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_suppliers" ADD CONSTRAINT "item_suppliers_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_suppliers" ADD CONSTRAINT "item_suppliers_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_suppliers" ADD CONSTRAINT "item_suppliers_site_id_supplier_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."supplier_sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_events" ADD CONSTRAINT "procurement_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_events" ADD CONSTRAINT "procurement_events_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_events" ADD CONSTRAINT "procurement_events_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_events" ADD CONSTRAINT "procurement_events_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_sites" ADD CONSTRAINT "supplier_sites_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_sites" ADD CONSTRAINT "supplier_sites_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "facilities_code_uq" ON "facilities" USING btree ("org_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_snapshots_point_uq" ON "inventory_snapshots" USING btree ("org_id","facility_id","item_id","captured_at");--> statement-breakpoint
CREATE INDEX "inventory_snapshots_item_idx" ON "inventory_snapshots" USING btree ("org_id","item_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "item_identifiers_value_uq" ON "item_identifiers" USING btree ("org_id","type","value");--> statement-breakpoint
CREATE INDEX "item_identifiers_item_idx" ON "item_identifiers" USING btree ("org_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "item_suppliers_pair_uq" ON "item_suppliers" USING btree ("org_id","item_id","supplier_id");--> statement-breakpoint
CREATE INDEX "item_suppliers_supplier_idx" ON "item_suppliers" USING btree ("org_id","supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "items_sku_uq" ON "items" USING btree ("org_id","sku");--> statement-breakpoint
CREATE INDEX "items_generic_idx" ON "items" USING btree ("org_id","generic_name");--> statement-breakpoint
CREATE UNIQUE INDEX "procurement_events_point_uq" ON "procurement_events" USING btree ("org_id","facility_id","item_id","ordered_at");--> statement-breakpoint
CREATE INDEX "procurement_events_item_idx" ON "procurement_events" USING btree ("org_id","item_id","ordered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_sites_code_uq" ON "supplier_sites" USING btree ("org_id","supplier_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_code_uq" ON "suppliers" USING btree ("org_id","code");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Row-level security. Same shape as 0013: ENABLE turns policies on for ordinary roles, FORCE
-- applies them to the table owner too (otherwise the owner — which is what a migration and most
-- local psql sessions connect as — silently bypasses every policy and the isolation suite goes
-- green while proving nothing), and the two-argument `current_setting(..., true)` returns NULL
-- rather than erroring when no tenant scope is set, so an unscoped connection reads ZERO rows
-- instead of failing in a way a caller might catch and treat as empty.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "items_org_isolation" ON "items"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);--> statement-breakpoint

ALTER TABLE "item_identifiers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "item_identifiers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "item_identifiers_org_isolation" ON "item_identifiers"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);--> statement-breakpoint

ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "suppliers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "suppliers_org_isolation" ON "suppliers"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);--> statement-breakpoint

ALTER TABLE "supplier_sites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "supplier_sites" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "supplier_sites_org_isolation" ON "supplier_sites"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);--> statement-breakpoint

ALTER TABLE "item_suppliers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "item_suppliers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "item_suppliers_org_isolation" ON "item_suppliers"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);--> statement-breakpoint

ALTER TABLE "facilities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "facilities" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "facilities_org_isolation" ON "facilities"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);--> statement-breakpoint

ALTER TABLE "inventory_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inventory_snapshots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "inventory_snapshots_org_isolation" ON "inventory_snapshots"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);--> statement-breakpoint

ALTER TABLE "procurement_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "procurement_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "procurement_events_org_isolation" ON "procurement_events"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);
