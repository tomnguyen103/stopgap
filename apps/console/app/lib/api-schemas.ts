import { z } from "zod";
import { createDocument, extendZodWithOpenApi, type ZodOpenApiObject } from "zod-openapi";
import {
  API_SCOPES,
  type ApiScope,
  type CatalogItemListRow,
  type ScoreListRow,
  type SignalListRow,
} from "@stopgap/db";
import { API_LIST_SCHEMAS, type ApiListResource } from "./api-list-query";
import { apiErrorSchema } from "./api-response";

/**
 * The public REST contract (PHASE6 §6.7): request/response schemas AND the OpenAPI 3.1 document,
 * in ONE module.
 *
 * The document is BUILT FROM the same Zod schemas the route handlers validate with, never
 * hand-written alongside them. A hand-maintained JSON blob is a document that is correct on the
 * day it is written and wrong from the first schema change onward — and an integrator who trusts
 * a stale spec writes a client that fails in production against an endpoint the spec swore was
 * fine. Deriving it means the spec cannot drift from the validation without the drift being a
 * compile error here.
 */

// zod-openapi v4 augments the zod instance with `.openapi()`. Called once, at module load, before
// any schema below is constructed — the augmentation must exist before the builders run.
extendZodWithOpenApi(z);

/** ISO-8601 instant. Timestamps cross the wire as strings so a client never guesses at a format. */
const isoDateTime = z.string().datetime();

export const caseSummarySchema = z
  .object({
    workflowId: z.string(),
    key: z.string(),
    genericName: z.string(),
    status: z.string(),
    severity: z.string().nullable(),
    updatedAt: isoDateTime,
  })
  .openapi({ ref: "CaseSummary", description: "A shortage case as it appears in the list view." });

export const caseListSchema = z
  .object({ cases: z.array(caseSummarySchema) })
  .openapi({ ref: "CaseList" });

export const caseDetailSchema = z
  .object({
    workflowId: z.string(),
    key: z.string(),
    genericName: z.string(),
    status: z.string(),
    severity: z.string().nullable(),
    source: z.string(),
    sourceId: z.string(),
    ndcs: z.array(z.string()),
    lastNote: z.string().nullable(),
    openedAt: isoDateTime,
    updatedAt: isoDateTime,
    closedAt: isoDateTime.nullable(),
  })
  .openapi({
    ref: "CaseDetail",
    description:
      "The durable case record. Reflects Postgres, which mirrors the workflow's state transitions; " +
      "it does not include in-flight agent output (draft text, proposed alternatives) that lives only " +
      "in the running workflow.",
  });

export const protocolSummarySchema = z
  .object({
    key: z.string(),
    title: z.string(),
    drugClass: z.string().nullable(),
    approvedVersion: z
      .number()
      .int()
      .nullable()
      .openapi({
        description: "The live version number, or null when every version is still a draft.",
      }),
    updatedAt: isoDateTime,
  })
  .openapi({ ref: "ProtocolSummary", description: "A protocol as it appears in the index." });

export const protocolListSchema = z
  .object({ protocols: z.array(protocolSummarySchema) })
  .openapi({ ref: "ProtocolList" });

export const protocolVersionSchema = z
  .object({
    version: z.number().int(),
    state: z.string(),
    authoredBy: z.string(),
    approvedBy: z.string().nullable(),
    rationale: z.string().nullable(),
  })
  .openapi({ ref: "ProtocolVersion" });

export const protocolSchema = z
  .object({
    approved: z
      .object({
        version: z.number().int(),
        body: z.string(),
        alternatives: z.array(z.string()),
        approvedBy: z.string().nullable(),
        rationale: z.string().nullable(),
      })
      .optional(),
    history: z.array(protocolVersionSchema),
  })
  .openapi({
    ref: "Protocol",
    description:
      "The approved substitution protocol for a shortage key plus its full version history. " +
      "`approved` is absent when the organization has never approved a version for this drug.",
  });

export const shadowClassStatsSchema = z
  .object({
    drugClass: z.string().nullable(),
    runs: z.number().int(),
    meanAgreement: z.number(),
    severityAgreementRate: z.number(),
    underEscalationRate: z.number(),
    meanLatencyMs: z.number(),
    totalUsdCost: z.number(),
  })
  .openapi({ ref: "ShadowClassStats" });

export const shadowStatsSchema = z
  .object({ classes: z.array(shadowClassStatsSchema) })
  .openapi({ ref: "ShadowStats" });

/**
 * Exception-resolution body. Byte-identical in shape to the console's own `resolutionSchema` —
 * same limits, same required fields — because an API caller and a pharmacist at the console are
 * writing the SAME organizational memory. A looser API schema would be a second, weaker door into
 * the protocol store.
 */
export const resolveExceptionSchema = z
  .object({
    protocolBody: z.string().min(1).max(20_000),
    alternatives: z.array(z.string().min(1).max(200)).max(20),
    rationale: z.string().min(1).max(2_000),
  })
  .openapi({ ref: "ResolveExceptionRequest" });

/**
 * Review decision body. The same discriminated union as the console's own `reviewDecisionSchema` —
 * same three kinds, same limits — because an API caller and a pharmacist at the console are making
 * the SAME clinical decision on the same workflow gate. A looser API shape would be a second,
 * weaker door into the HITL gate that the console's is designed to be the only one for.
 */
export const reviewDecisionSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("approve") }),
    z.object({ kind: z.literal("edit"), editedDraft: z.string().min(1).max(20_000) }),
    z.object({ kind: z.literal("reject"), reason: z.string().min(1).max(2_000) }),
  ])
  .openapi({
    ref: "ReviewDecision",
    description:
      "`approve` accepts the agent's draft as written; `edit` replaces it with `editedDraft`; " +
      "`reject` sends the case back with `reason`. The reviewer identity is NOT part of the body — " +
      "it is the API key presented on the request, so a caller cannot claim to be someone else.",
  });

export const approveVersionSchema = z
  .object({
    rationale: z
      .string()
      .min(1)
      .max(2_000)
      .optional()
      .openapi({
        description:
          "Why this version is being approved. Recorded in the AUDIT CHAIN entry for this approval — " +
          "it is NOT written to the version row, so `GET /api/v1/protocols/{key}` will not echo it " +
          "back. A version's own `rationale` is the reasoning captured when the version was DRAFTED; " +
          "overwriting it at approval time would replace the author's words with the approver's.",
      }),
  })
  .openapi({ ref: "ApproveVersionRequest" });

export const acceptedSchema = z
  .object({ ok: z.literal(true), key: z.string() })
  .openapi({
    ref: "Accepted",
    description: "The write was accepted and recorded in the audit chain.",
  });

export const approvedSchema = z
  .object({ ok: z.literal(true), version: z.number().int(), changed: z.boolean() })
  .openapi({
    ref: "Approved",
    description:
      "`changed` is false when the version was already approved — a no-op, not a new approval.",
  });

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * ---------------------------------------------------------------------------------------------
 * Signals, scores and catalog (ticket 19).
 * ---------------------------------------------------------------------------------------------
 *
 * Numerics cross the wire as NUMBERS, not as the `numeric` column's string. Postgres returns
 * `numeric` as a string so a client cannot silently lose precision; a JSON API that passed that
 * string through would make every consumer parse it, and the first one to forget would compare
 * `"9.5" > "10"` and get true. The mappers below do the conversion once, here.
 */

export const pageMetaSchema = z
  .object({
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int().openapi({ description: "Rows matching the filters, across all pages." }),
  })
  .openapi({ ref: "PageMeta" });

export const signalSchema = z
  .object({
    key: z.string().openapi({ description: "The signal's dedupe key — `<org>:<source>:<sourceId>`." }),
    source: z.string(),
    sourceId: z.string(),
    riskDomain: z.string(),
    entityType: z.string(),
    entityIdentifier: z.string(),
    title: z.string(),
    summary: z.string(),
    severity: z.string(),
    severityScore: z.number().openapi({
      description:
        "The INGEST heuristic, 0–1, carried beside the label. It is one input to the risk score — " +
        "never the risk score itself; rank on `GET /api/v1/scores`.",
    }),
    confidence: z.number(),
    staleness: z.string(),
    sourceResolved: z.boolean().openapi({
      description: "The source says the hazard is over. The signal still carries decayed weight.",
    }),
    observedAt: isoDateTime,
    publishedAt: isoDateTime,
    evidenceUrl: z.string(),
  })
  .openapi({ ref: "Signal", description: "A normalized risk signal as the platform stored it." });

export const signalListSchema = z
  .object({ signals: z.array(signalSchema), page: pageMetaSchema })
  .openapi({ ref: "SignalList" });

export const scoreSchema = z
  .object({
    signalKey: z.string(),
    title: z.string(),
    riskDomain: z.string(),
    score: z.number().openapi({ description: "0–100, the deterministic scorer's number." }),
    band: z.string(),
    reachableMax: z.number().openapi({
      description:
        "The points this score COULD have earned given what was knowable when it was computed. " +
        "Two snapshots with different `reachableMax` are not directly comparable.",
    }),
    scorerVersion: z.string(),
    computedAt: isoDateTime,
  })
  .openapi({
    ref: "Score",
    description:
      "The most recent score snapshot for one signal. The score is arithmetic over the signal and " +
      "the facility's catalog exposure (ADR-0002) — no model produces it.",
  });

export const scoreListSchema = z
  .object({ scores: z.array(scoreSchema), page: pageMetaSchema })
  .openapi({ ref: "ScoreList" });

export const catalogItemSchema = z
  .object({
    sku: z.string(),
    name: z.string(),
    genericName: z.string().nullable(),
    unit: z.string().nullable(),
    updatedAt: isoDateTime,
  })
  .openapi({
    ref: "CatalogItem",
    description:
      "One stocked product as the facility records it. Stock levels, suppliers and prices are not " +
      "part of this resource.",
  });

export const catalogItemListSchema = z
  .object({ items: z.array(catalogItemSchema), page: pageMetaSchema })
  .openapi({ ref: "CatalogItemList" });

/** Row → resource. One place where `numeric` strings and `Date`s become JSON. */
export function toSignalResource(row: SignalListRow): z.infer<typeof signalSchema> {
  return {
    key: row.dedupeKey,
    source: row.source,
    sourceId: row.sourceId,
    riskDomain: row.riskDomain,
    entityType: row.entityType,
    entityIdentifier: row.entityIdentifier,
    title: row.title,
    summary: row.summary,
    severity: row.severity,
    severityScore: Number(row.severityScore),
    confidence: Number(row.confidence),
    staleness: row.staleness,
    sourceResolved: row.sourceResolved,
    observedAt: row.observedAt.toISOString(),
    publishedAt: row.publishedAt.toISOString(),
    evidenceUrl: row.evidenceUrl,
  };
}

export function toScoreResource(row: ScoreListRow): z.infer<typeof scoreSchema> {
  return {
    signalKey: row.dedupeKey,
    title: row.title,
    riskDomain: row.riskDomain,
    score: Number(row.score),
    band: row.band,
    reachableMax: Number(row.reachableMax),
    scorerVersion: row.scorerVersion,
    computedAt: row.computedAt.toISOString(),
  };
}

export function toCatalogItemResource(row: CatalogItemListRow): z.infer<typeof catalogItemSchema> {
  return {
    sku: row.sku,
    name: row.name,
    genericName: row.genericName,
    unit: row.unit,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The documented query parameters of a console-vocabulary list endpoint, derived from the SAME
 * schema the route parses with — so the published contract cannot claim a sort key or filter value
 * the parser would drop.
 *
 * Every parameter is optional and every one degrades to its default, which is why none of them is
 * described as required and why these endpoints publish no 400.
 */
function listParamsQuery(resource: ApiListResource, searchedFields: string): z.ZodTypeAny {
  const schema = API_LIST_SCHEMAS[resource];
  const shape: Record<string, z.ZodTypeAny> = {
    // WHICH fields `q` searches differs per resource, so each one says so: a single "substring
    // search" description across three endpoints would leave a caller to discover by experiment
    // that searching scores by an NDC returns nothing.
    q: z
      .string()
      .optional()
      .openapi({ description: `Case-insensitive substring search over ${searchedFields}.` }),
    sort: z.enum(schema.sortKeys as unknown as [string, ...string[]]).optional()
      .openapi({ description: `Sort key. Defaults to \`${schema.defaultSort}\`.` }),
    dir: z.enum(["asc", "desc"]).optional().openapi({ description: `Defaults to \`${schema.defaultDir}\`.` }),
    // Bounds are published, not merely described: a generated client that offers an unconstrained
    // integer invites values this parser silently discards, and "my page parameter did nothing" is
    // the least debuggable failure an integrator can hit.
    page: z.coerce.number().int().min(1).max(10_000).optional().openapi({ description: "1-based." }),
    pageSize: z.coerce
      .number()
      .int()
      .optional()
      .openapi({
        description: `Defaults to ${schema.defaultPageSize}.`,
        param: { schema: { type: "integer", enum: [...schema.pageSizes] } },
      }),
  };
  for (const [key, values] of Object.entries(schema.filters)) {
    shape[key] = z
      .array(z.enum(values as unknown as [string, ...string[]]))
      .optional()
      .openapi({ description: `Repeatable. Values outside the list are dropped.` });
  }
  return z.object(shape);
}

const errorSchema = apiErrorSchema.openapi({ ref: "Error" });

/** The three failure responses every authenticated operation can produce. */
const authFailureResponses = {
  "401": {
    description: "Missing, unknown, or revoked API key.",
    content: { "application/json": { schema: errorSchema } },
  },
  "403": {
    description: "The key does not carry the scope this operation requires.",
    content: { "application/json": { schema: errorSchema } },
  },
  "429": {
    description: "The key is over its hourly rate limit. See `Retry-After`.",
    content: { "application/json": { schema: errorSchema } },
  },
};

const notFoundResponse = {
  "404": {
    description: "No such resource.",
    content: { "application/json": { schema: errorSchema } },
  },
};

/**
 * The write-path failures that are neither the caller's malformed input nor a missing resource: the
 * request was well-formed and addressed something real, but the state it assumed has moved (409) or
 * the workflow engine behind the write is unreachable (503). Both are documented because a client
 * must be able to tell "stop, re-read, and try something else" from "retry this shortly".
 */
const writeConflictResponses = {
  "409": {
    description:
      "The target's state no longer permits this operation (e.g. the version was superseded).",
    content: { "application/json": { schema: errorSchema } },
  },
};

const temporalUnavailableResponse = {
  "503": {
    description:
      "The write was NOT applied: Stopgap could not reach Temporal to signal the case's durable workflow.",
    content: { "application/json": { schema: errorSchema } },
  },
};

const badRequestResponse = {
  "400": {
    description: "The request failed schema validation; `issues` names the bad fields.",
    content: { "application/json": { schema: errorSchema } },
  },
};

/**
 * The custom field naming each operation's required scope.
 *
 * OpenAPI attaches scopes to a `security` entry only for `oauth2`/`openIdConnect` schemes; this
 * API uses a plain bearer token, for which the spec's `security` array carries no scope list. So
 * the scope is published as a documented extension AND restated in the operation description —
 * a machine-readable field for tooling, prose for a human reading Swagger UI. Silently omitting
 * it would leave "which scope does this need" answerable only by triggering a 403.
 */
const SCOPE_EXTENSION = "x-required-scope" as const;

function scoped(scope: ApiScope): { [SCOPE_EXTENSION]: ApiScope } {
  return { [SCOPE_EXTENSION]: scope };
}

/** Prefix every description with the scope, so the requirement is visible without reading the extension. */
function withScope(scope: ApiScope, description: string): string {
  return `Requires the \`${scope}\` scope. ${description}`;
}

const keyPathParam = z.object({
  key: z
    .string()
    .min(1)
    .openapi({ description: "The normalized generic-name dedup key, e.g. `cefazolin`." }),
});

/**
 * Build the OpenAPI 3.1 document. A function rather than a module constant so the test can build
 * it in isolation and so a future PR can vary the server URL per deployment without a module-load
 * side effect.
 */
export function buildOpenApiDocument(): ReturnType<typeof createDocument> {
  const doc: ZodOpenApiObject = {
    openapi: "3.1.0",
    info: {
      title: "Stopgap Public API",
      version: "1.0.0",
      description:
        "Programmatic access to the Stopgap drug-shortage platform (PHASE6 §6.7).\n\n" +
        "Authenticate with `Authorization: Bearer <key>` using a key issued from the console's " +
        "`/admin/api-keys` page. Every key carries an explicit set of scopes " +
        `(${API_SCOPES.map((s) => `\`${s}\``).join(", ")}) and a per-hour rate limit; an operation ` +
        "refuses a key that lacks its scope with 403 and a key over its limit with 429.\n\n" +
        "A deployment that has issued no keys answers 401 to everything — the API is closed until " +
        "an administrator opens it, never open by default.",
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "An API key issued from /admin/api-keys. The plaintext is displayed once at issue time; " +
            "the server stores only its SHA-256 hash, so a lost key must be revoked and reissued.",
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/v1/cases": {
        get: {
          summary: "List shortage cases",
          description: withScope("cases:read", "Recent cases, most recently updated first."),
          ...scoped("cases:read"),
          requestParams: { query: listQuerySchema },
          responses: {
            "200": {
              description: "Cases.",
              content: { "application/json": { schema: caseListSchema } },
            },
            ...badRequestResponse,
            ...authFailureResponses,
          },
        },
      },
      "/api/v1/cases/{key}": {
        get: {
          summary: "Get one case",
          description: withScope("cases:read", "The durable case record for a shortage key."),
          ...scoped("cases:read"),
          requestParams: { path: keyPathParam },
          responses: {
            "200": {
              description: "The case.",
              content: { "application/json": { schema: caseDetailSchema } },
            },
            ...notFoundResponse,
            ...authFailureResponses,
          },
        },
      },
      "/api/v1/cases/{key}/resolve-exception": {
        post: {
          summary: "Resolve a case blocked at the exception gate",
          description: withScope(
            "protocols:write",
            "Signals the durable workflow with the substitution guidance to adopt. Refused with 403 " +
              "while the deployment is a read-only public demo.",
          ),
          ...scoped("protocols:write"),
          requestParams: { path: keyPathParam },
          requestBody: { content: { "application/json": { schema: resolveExceptionSchema } } },
          responses: {
            "202": {
              description: "Signal accepted.",
              content: { "application/json": { schema: acceptedSchema } },
            },
            ...badRequestResponse,
            ...notFoundResponse,
            ...authFailureResponses,
            ...temporalUnavailableResponse,
          },
        },
      },
      "/api/v1/cases/{key}/review": {
        post: {
          summary: "Record the human review decision on a case's drafted protocol",
          description: withScope(
            "protocols:write",
            "Signals the durable workflow's human-in-the-loop gate with an approve / edit / reject " +
              "decision. The reviewer recorded in the audit chain is the API key and the human who " +
              "issued it — never a claimed identity from the body. Refused with 403 while the " +
              "deployment is a read-only public demo.",
          ),
          ...scoped("protocols:write"),
          requestParams: { path: keyPathParam },
          requestBody: { content: { "application/json": { schema: reviewDecisionSchema } } },
          responses: {
            "202": {
              description: "Signal accepted.",
              content: { "application/json": { schema: acceptedSchema } },
            },
            ...badRequestResponse,
            ...notFoundResponse,
            ...authFailureResponses,
            ...temporalUnavailableResponse,
          },
        },
      },
      "/api/v1/protocols": {
        get: {
          summary: "List substitution protocols",
          description: withScope(
            "protocols:read",
            "The protocol index, most recently updated first: key, title, drug class, and the live " +
              "approved version number (null when every version is still a draft).",
          ),
          ...scoped("protocols:read"),
          requestParams: { query: listQuerySchema },
          responses: {
            "200": {
              description: "Protocols.",
              content: { "application/json": { schema: protocolListSchema } },
            },
            ...badRequestResponse,
            ...authFailureResponses,
          },
        },
      },
      "/api/v1/protocols/{key}": {
        get: {
          summary: "Get a substitution protocol",
          description: withScope(
            "protocols:read",
            "The approved protocol for a drug plus its version history.",
          ),
          ...scoped("protocols:read"),
          requestParams: { path: keyPathParam },
          responses: {
            "200": {
              description: "The protocol.",
              content: { "application/json": { schema: protocolSchema } },
            },
            ...authFailureResponses,
          },
        },
      },
      "/api/v1/protocols/{key}/versions/{version}/approve": {
        post: {
          summary: "Approve a drafted protocol version",
          description: withScope(
            "protocols:write",
            "Promotes a draft to the live protocol and supersedes the previous approved version. " +
              "Refused with 403 while the deployment is a read-only public demo.",
          ),
          ...scoped("protocols:write"),
          requestParams: {
            path: keyPathParam.extend({
              version: z.coerce
                .number()
                .int()
                .min(1)
                .openapi({ description: "The per-protocol version number." }),
            }),
          },
          requestBody: { content: { "application/json": { schema: approveVersionSchema } } },
          responses: {
            "200": {
              description: "Approval result.",
              content: { "application/json": { schema: approvedSchema } },
            },
            ...badRequestResponse,
            ...notFoundResponse,
            ...writeConflictResponses,
            ...authFailureResponses,
          },
        },
      },
      "/api/v1/signals": {
        get: {
          summary: "List risk signals",
          description: withScope(
            "signals:read",
            "The normalized signals this organization is tracking, newest publication first. " +
              "Filtering and pagination use the console's vocabulary; an unusable parameter " +
              "degrades to its default rather than failing the request.",
          ),
          ...scoped("signals:read"),
          requestParams: { query: listParamsQuery("signals", "the title and the entity identifier") },
          responses: {
            "200": { description: "Signals.", content: { "application/json": { schema: signalListSchema } } },
            ...authFailureResponses,
          },
        },
      },
      "/api/v1/signals/{key}": {
        get: {
          summary: "Get one risk signal",
          description: withScope("signals:read", "One signal by its dedupe key."),
          ...scoped("signals:read"),
          requestParams: {
            path: z.object({
              key: z.string().min(1).openapi({ description: "The signal's dedupe key." }),
            }),
          },
          responses: {
            "200": { description: "The signal.", content: { "application/json": { schema: signalSchema } } },
            ...notFoundResponse,
            ...authFailureResponses,
          },
        },
      },
      "/api/v1/scores": {
        get: {
          summary: "List current risk scores",
          description: withScope(
            "scores:read",
            "The latest score snapshot per signal, highest score first. This is the number the " +
              "console ranks on; `Signal.severityScore` is an input to it, not a substitute for it.",
          ),
          ...scoped("scores:read"),
          requestParams: { query: listParamsQuery("scores", "the signal title") },
          responses: {
            "200": { description: "Scores.", content: { "application/json": { schema: scoreListSchema } } },
            ...authFailureResponses,
          },
        },
      },
      "/api/v1/catalog/items": {
        get: {
          summary: "List catalog items",
          description: withScope(
            "catalog:read",
            "The products this facility stocks, by sku. Quantities, suppliers and prices are not " +
              "part of this resource.",
          ),
          ...scoped("catalog:read"),
          requestParams: { query: listParamsQuery("catalogItems", "the sku, name and generic name") },
          responses: {
            "200": { description: "Items.", content: { "application/json": { schema: catalogItemListSchema } } },
            ...authFailureResponses,
          },
        },
      },
      "/api/v1/shadow/stats": {
        get: {
          summary: "Shadow-mode aggregates by drug class",
          description: withScope(
            "shadow:read",
            "Agreement, under-escalation, latency and cost per drug class.",
          ),
          ...scoped("shadow:read"),
          responses: {
            "200": {
              description: "Aggregates.",
              content: { "application/json": { schema: shadowStatsSchema } },
            },
            ...authFailureResponses,
          },
        },
      },
    },
  };
  return createDocument(doc);
}
