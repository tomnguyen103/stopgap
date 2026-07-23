# Phase 5 — Out of scope this run (ship / deploy / extract / writeups)

Per the build instructions, this run stops when Phase 4 is verified. Everything below is
deferred to Phase 5.

## Deferred from the plan (§13 Phase 5, §11 deployment)

- Hetzner VPS deploy via docker-compose (app, worker, Temporal + UI, Postgres, Langfuse,
  Ollama container, Caddy auto-TLS). Subdomains per §11.
- Demo mode: read-only guest, nightly re-seed of mid-lifecycle cases, "Run a shortage"
  interactive scenario, daily budget cap → Ollama fallback, demo video fallback.
- Extract `shadow-ledger` as a standalone open-source npm library (§12.5).
- Engineering writeup + dev.to crosspost; published failure post-mortem; portfolio page;
  3-min demo video.

## Stubbed during this run — needs real credentials/config before Phase 5

- **`GEMINI_API_KEY` absent.** The Gemini provider is implemented but not exercised
  against the live API. Local gate + CI run on Ollama. Set the key and run the
  Gemini-vs-Ollama eval to produce the comparison table with real numbers.
- **`RESEND_API_KEY` absent.** Outbound comms (Phase 4) fall back to a local file/console
  transport. Set the key + `COMMS_DEMO_INBOX` to send real demo emails.
- **Langfuse keys absent.** Self-hosted Langfuse is wired via OTel; without keys, traces
  export to a local/console OTel exporter. Provision Langfuse + keys for real tracing.
- **openFDA API key absent (optional).** Polling works unauthenticated at a lower rate
  limit; add `OPENFDA_API_KEY` for higher throughput.

## Notes

- `.env.example` documents every variable. Copy to `.env` and fill before deploy.
