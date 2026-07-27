# 17 — Administrator dashboard

**What to build:** The administrator's operations surface. They land on what still needs configuring and whether the system is healthy. From here they load and inspect the facility's catalog, see which items are sole-sourced, check whether any data feed has gone quiet, and manage the access that everything else depends on.

**Blocked by:** 03, 15, 16

**Status:** ready-for-agent

- [ ] The administrator lands on a setup checklist and system health
- [ ] Catalog files can be uploaded from the dashboard, with per-row failures shown clearly enough to correct the file
- [ ] The catalog can be browsed and searched, with list state carried in the page address
- [ ] An item detail view shows its identifiers, suppliers, inventory position and any signals matched to it
- [ ] Sole-sourced items are identifiable
- [ ] Connector health and last-run time are visible, so a silent feed is noticed
- [ ] Existing user, role, API key and organization management remain reachable and unchanged in behaviour
- [ ] Model spend caps are configurable
- [ ] A demo workspace containing no real facility data can be seeded
