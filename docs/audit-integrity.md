# Audit integrity (Phase 6 §6.2)

The audit log (`audit_log`) is an append-only, hash-chained record: every row's `hash` links
to the previous row's, so any later edit breaks the chain from that point on. Phase 6 hardens
it two ways and adds a way to check it.

## What changed

- **Keyed HMAC (`AUDIT_HMAC_KEY`).** Rows carry a `scheme`: `v1` is the original bare
  SHA-256; `v2` is HMAC-SHA-256 under a key that lives *outside* the database. With the key
  set, an attacker who only has DB write access can no longer recompute a valid chain.
  Existing `v1` rows keep verifying — turning the key on is not a silent downgrade. Unset is
  honest non-configuration, exactly like the comms non-delivery stance.
- **External anchoring (`audit_anchors`).** An hourly Temporal schedule (`anchor-audit`)
  records the current chain head `(maxAuditId, headHash)` to an append-only file
  (`AUDIT_ANCHOR_FILE`), and — if `AUDIT_TSA_URL` is set — an RFC 3161 timestamp token. This
  catches even a key holder who rewrites history, because the original head hash also lives
  somewhere they cannot silently edit. A failing/absent TSA is recorded as `sink: "file"`,
  never a faked token.
- **Verification.** The console page **Audit** (`/audit`) verifies the chain from genesis and
  cross-checks stored anchors against the live chain. The CLI `pnpm verify-audit` does the
  same headlessly and exits non-zero on any break — usable from cron or a deploy gate.

## Demo: tamper a row, watch it flip red

With Postgres running (`pnpm infra:up`) and some cases seeded:

```sql
-- Pick any historical row and tamper its payload.
UPDATE audit_log SET detail = detail || '{"tampered":true}'::jsonb
WHERE id = (SELECT min(id) FROM audit_log);
```

Then either:

- open `/audit` in the console — the banner turns red and names the first broken row id; or
- run `pnpm verify-audit` — it prints `chain BROKEN at row <id> (hash-mismatch)` and exits 1.

Editing `actor`, `detail`, or `case_id` on any historical row all break verification at that
row. With `AUDIT_HMAC_KEY` set, dropping the key and re-verifying fails at the first `v2` row
(`missing-hmac-key`) — recomputing the chain without the key cannot produce valid rows.

To see anchoring cross-checks, let the `anchor-audit` schedule run (or invoke the
`anchorAuditWorkflow` once); rewriting a row that an anchor already pinned makes that anchor's
`head matches` column show `✗ mismatch` on the Audit page.

## Config

| Var | Default | Meaning |
| --- | --- | --- |
| `AUDIT_HMAC_KEY` | unset | HMAC key → `v2` rows. Unset keeps `v1`. Store in a KMS in prod. |
| `AUDIT_ANCHOR_FILE` | `.audit-anchors/anchors.log` | Append-only file sink (Docker volume in prod). |
| `AUDIT_TSA_URL` | unset | Optional RFC 3161 authority. Unset = file is the only sink. |
