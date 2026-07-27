# 15 — Catalog schema and CSV import

**What to build:** The platform learns what this hospital actually stocks. An administrator uploads the facility's catalog — items with their many identifiers, suppliers and their sites, facilities, inventory levels and procurement history — and the platform stops guessing. This is the single largest ticket in the programme and the one that turns simulated impact assessment into real analysis.

Import must be safe to get wrong: a bad file reports precisely which rows failed and why, leaves nothing behind, and a corrected re-upload does not duplicate what already landed.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] Items, item identifiers, suppliers, supplier sites, item-supplier links, facilities, inventory snapshots and procurement events persist as tenant tables with organization references and row-level policies
- [ ] An item can carry several identifier types at once, since facilities record products differently across systems
- [ ] A CSV upload populates the catalog within a single transaction per file
- [ ] Invalid rows are reported individually with the reason, and a failed import leaves no partial data
- [ ] Re-uploading a corrected file updates rather than duplicating, keyed on item identifiers
- [ ] Parsing, coercion and validation are pure and tested directly, separately from the write
- [ ] Isolation coverage proves every new table is unreadable and unwritable from another tenant's scope
- [ ] Migrations apply cleanly as the role a real deployment migrates as
