# 16 — Signal matching, score completion, and mock retirement

PR batch: A

**What to build:** The two halves meet. Incoming signals are matched against the facility's real catalog, which switches on the score components that have been dark since the scorer landed — stock levels and supplier concentration, together a third of the total. Scores become complete, and the console stops declaring them partial. With real catalog data flowing, the simulated formulary and inventory are removed and impact assessment reads the real thing.

This is the convergence point of the programme. It is blocked by the most and gates the most.

**Blocked by:** 07, 15

**Status:** ready-for-agent

- [x] Signals match tenant catalog items via their identifiers, using the contract's match hints
- [x] Matching and scoring resolve their default confidence from the same shared constant
- [x] Stock-level and supplier-concentration score components activate and contribute
- [x] Scores are complete, and the console no longer reports components as unavailable
- [x] A previously scored signal rescored after catalog import produces a higher-or-equal total, never lower
- [x] Impact assessment reads the real catalog; the simulated formulary and inventory are removed
- [x] Items sourced from a single supplier are identifiable
- [x] No case or signal is lost or orphaned in the transition
