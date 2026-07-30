# 04 — Browser smoke tier

PR batch: B

**What to build:** The behaviours that genuinely cannot be proven below a browser — signing in, landing on the right dashboard, and seeing an above-role control refused — get automated coverage. This tier is deliberately narrow: everything expressible as a pure function stays in the offline gate, because a broad browser suite that breaks on a class-name change gets disabled within a month.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] A browser test tier exists and runs on demand, separately from the default offline gate
- [ ] Signing in as each of the four seeded role users succeeds
- [ ] Each role lands on its own dashboard
- [ ] A control for an action above the signed-in role renders disabled and names the required role
- [ ] The anonymous demo path reaches the viewer dashboard and cannot mutate
- [ ] The tier asserts none of: table sorting, filtering, searching or pagination — those stay covered by the pure list-state tests
- [ ] The default gate remains fully offline and does not require a browser
