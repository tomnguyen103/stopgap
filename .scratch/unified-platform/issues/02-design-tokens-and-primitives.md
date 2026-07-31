# 02 — Design tokens and shared primitives

PR batch: B

**What to build:** The console's existing dark identity becomes a real design system rather than a single hand-written stylesheet, so the four dashboards can be built from shared parts instead of bespoke markup. The current palette — surface, panel, line, text, muted, accent and the severity ramp — is declared as the token layer, and a small set of presentational primitives is built on those tokens.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] The existing palette is the token source; no second palette is introduced and no colour is hard-coded beside a token
- [x] Primitives exist for badge, button, card, input and table, all consuming tokens
- [x] One existing console page is rebuilt on the primitives and is visually unchanged, proving old and new styling coexist without drift
- [x] Every other existing page continues to render correctly against the current stylesheet, untouched
- [x] Severity styling resolves from the same tokens the existing severity classes use, so a critical case looks identical either way
- [x] The build gate stays green and the production bundle does not regress materially
