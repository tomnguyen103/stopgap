# 19 — Expose signals, scores and catalog on the public API

PR batch: A

**What to build:** An integrator can pull risk signals, scores and catalog data out of the platform programmatically, under the same scoped-key authorization that already governs cases and protocols, and generate a client from the published description. No second authentication mechanism is introduced.

**Blocked by:** 07, 15

**Status:** ready-for-agent

- [x] Signals, scores and catalog resources are readable through the versioned API
- [x] Access uses the existing scoped-key mechanism, and the organization derives from the presented key
- [x] A key lacking the required scope is refused
- [x] A key cannot read another organization's data
- [x] The generated API description covers the new resources well enough to generate a working client
- [x] Responses follow the existing shape and error conventions
- [x] List endpoints support the same filtering and pagination vocabulary as the console
