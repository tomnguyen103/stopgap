# 03 — Route groups and per-role landing

**What to build:** Each role gets its own dashboard. After signing in, a pharmacist lands on the pharmacist surface, a director on theirs, an admin on theirs — each with its own navigation — rather than everyone arriving at the same list. The anonymous demo visitor reaches the viewer surface, which makes the public demo and the lowest-privilege dashboard one thing to maintain rather than two.

The pure role-to-landing-route resolution and the pure list-state module already exist and are unit-tested; this ticket consumes them rather than reimplementing either.

**Blocked by:** 01 (need a real sign-in to land anywhere), 02 (need primitives for the shells)

**Status:** ready-for-agent

- [ ] Four dashboard groups exist, each with its own layout and navigation
- [ ] Signing in redirects to the landing route of the caller's highest role
- [ ] A multi-role user lands on their highest role's dashboard
- [ ] An anonymous demo visitor reaches the viewer dashboard without authentication and without a redirect loop
- [ ] The root layout remains static — session state is read only within a group layout, never above it
- [ ] Every page and every server action still performs its own authorization check; reaching a route grants nothing
- [ ] Navigating directly to another role's route is refused server-side, identically to an unauthenticated request
- [ ] Controls for actions above the caller's role render disabled and state the required role, rather than being hidden
