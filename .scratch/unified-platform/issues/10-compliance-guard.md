# 10 — Compliance guard

PR batch: A

**What to build:** The product claims it never handles protected health information and never gives clinical advice. This makes that claim enforceable at runtime rather than asserted in prose. Generated text is screened before it leaves the system's control — both before it reaches a screen and before it is sent anywhere — and a violation is reported with enough detail to act on rather than as a bare refusal.

**Blocked by:** None — can start immediately

**Status:** done

- [x] A pure screening module detects protected-information patterns (record numbers, dates of birth, national identifiers, contact details), records-system references, diagnosis and treatment language, patient-specific phrasing, and substitution directives
- [x] It returns a structured report naming the category and the offending excerpt, not a bare boolean
- [x] It is applied at the outbound communications boundary, so nothing that violates the boundary is ever sent
- [x] Blocked content is recorded rather than silently dropped, so a false positive is discoverable
- [x] The module is pure — no network, no database — and tested directly against known patterns
- [x] Existing communication guarantees are preserved: a missing credential is still recorded as unconfigured and never faked as sent
