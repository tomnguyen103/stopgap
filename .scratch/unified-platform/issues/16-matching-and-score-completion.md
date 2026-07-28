# 16 — Signal matching, score completion, and mock retirement

PR batch: A

**What to build:** The two halves meet. Incoming signals are matched against the facility's real catalog, which switches on the score components that have been dark since the scorer landed — stock levels and supplier concentration, together a third of the total. Scores become complete, and the console stops declaring them partial. With real catalog data flowing, the simulated formulary and inventory are removed and impact assessment reads the real thing.

This is the convergence point of the programme. It is blocked by the most and gates the most.

**Blocked by:** 07, 15

**Status:** ready-for-agent

- [ ] Signals match tenant catalog items via their identifiers, using the contract's match hints
- [ ] Matching and scoring resolve their default confidence from the same shared constant
- [ ] Stock-level and supplier-concentration score components activate and contribute
- [ ] Scores are complete, and the console no longer reports components as unavailable
- [ ] A previously scored signal rescored after catalog import produces a higher-or-equal total, never lower
- [ ] Impact assessment reads the real catalog; the simulated formulary and inventory are removed
- [ ] Items sourced from a single supplier are identifiable
- [ ] No case or signal is lost or orphaned in the transition
