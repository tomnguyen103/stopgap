import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_SCOPES } from "@stopgap/db";
import { buildOpenApiDocument } from "./api-schemas";

/**
 * The OpenAPI document (PHASE6 §6.7). These assertions are the contract-drift alarm: the document
 * is derived from the same Zod schemas the routes validate with, so a route added without a spec
 * entry — or a spec entry whose scope nobody stated — fails here rather than reaching an
 * integrator as a surprise 403.
 */

const doc = buildOpenApiDocument();

/** Where the route handlers live, resolved from THIS file so the test does not depend on the cwd. */
const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "api", "v1");

/**
 * Routes under `/api/v1` that are deliberately absent from the document.
 *
 * These two ARE the documentation surface. Listing them as operations would have the spec describe
 * itself, and neither is part of the contract an integrator writes a client against — they are
 * session-gated pages/documents for a human, not key-scoped API operations (see `api-docs-gate.ts`).
 * An explicit exclusion list is the point: adding a real route stays a failure here, while these two
 * are excused in writing rather than by the discovery logic quietly missing them.
 */
const NON_CONTRACT_ROUTES = new Set(["/api/v1/docs", "/api/v1/openapi.json"]);

/** Every directory under `API_ROOT` that contains a `route.ts`, as OS paths. */
function findRouteFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return findRouteFiles(join(dir, entry.name));
    return entry.name === "route.ts" ? [join(dir, entry.name)] : [];
  });
}

/**
 * Discover the implemented operations by walking the filesystem rather than by maintaining a list.
 *
 * The previous hand-written array made this whole file assert a tautology: adding a route AND
 * forgetting its spec entry left the array — and therefore the test — describing the old world, so
 * the drift alarm stayed silent for exactly the mistake it exists to catch. Next's routing IS the
 * directory tree, so the tree is the only source of truth that cannot fall behind: a directory
 * segment maps to a path segment, `[key]` to the OpenAPI template `{key}`, and each exported HTTP
 * handler to an operation.
 */
function discoverOperations(): [path: string, method: "get" | "post"][] {
  return findRouteFiles(API_ROOT)
    .flatMap((file): [string, "get" | "post"][] => {
      const segments = relative(API_ROOT, dirname(file)).split(sep).filter(Boolean);
      const path = posix.join("/api/v1", ...segments.map((s) => s.replace(/^\[(.+)]$/, "{$1}")));
      if (NON_CONTRACT_ROUTES.has(path)) return [];
      const source = readFileSync(file, "utf8");
      return (["get", "post"] as const)
        .filter((method) => new RegExp(`export\\s+async\\s+function\\s+${method.toUpperCase()}\\b`).test(source))
        .map((method) => [path, method]);
    })
    .sort(([a], [b]) => a.localeCompare(b));
}

const IMPLEMENTED_OPERATIONS = discoverOperations();

describe("security scheme", () => {
  it("documents bearer authentication and applies it document-wide", () => {
    expect(doc.components?.securitySchemes?.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
  });

  it("states that an un-keyed deployment is closed, not open", () => {
    expect(doc.info.description).toContain("401");
  });
});

describe("paths", () => {
  it("discovers the route handlers on disk (a broken walk must not vacuously pass)", () => {
    // Every assertion below iterates this list, so an empty or truncated discovery would turn the
    // whole suite green while checking nothing. Assert the walk found real routes first.
    expect(IMPLEMENTED_OPERATIONS.length).toBeGreaterThanOrEqual(6);
    expect(IMPLEMENTED_OPERATIONS).toContainEqual(["/api/v1/cases", "get"]);
    expect(IMPLEMENTED_OPERATIONS).toContainEqual(["/api/v1/cases/{key}/resolve-exception", "post"]);
  });

  it("documents exactly one operation per implemented route", () => {
    for (const [path, method] of IMPLEMENTED_OPERATIONS) {
      expect(doc.paths?.[path], `missing path ${path}`).toBeDefined();
      expect(doc.paths?.[path]?.[method], `missing ${method.toUpperCase()} ${path}`).toBeDefined();
    }
    // No documented path without an implementation behind it (the spec must not over-promise).
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual([...new Set(IMPLEMENTED_OPERATIONS.map(([p]) => p))].sort());
  });

  it("names a known scope on EVERY operation, in both the extension and the description", () => {
    for (const [path, method] of IMPLEMENTED_OPERATIONS) {
      const operation = doc.paths?.[path]?.[method] as Record<string, unknown> | undefined;
      const scope = operation?.["x-required-scope"];
      expect(typeof scope, `${method} ${path} has no x-required-scope`).toBe("string");
      expect(API_SCOPES).toContain(scope as string);
      expect(String(operation?.description)).toContain(String(scope));
    }
  });

  /**
   * A client generated from this document has to be able to PAGE and FILTER, not merely to fetch
   * page one (ticket 19: "generates a working client"). The three console-vocabulary lists
   * therefore have to publish those parameters — a spec that documented only the response shape
   * would generate a client that silently cannot reach row 51.
   */
  it("publishes the console list vocabulary on the signal, score and catalog lists", () => {
    for (const path of ["/api/v1/signals", "/api/v1/scores", "/api/v1/catalog/items"]) {
      const parameters = (doc.paths?.[path]?.get as { parameters?: { name: string }[] })?.parameters ?? [];
      const names = parameters.map((p) => p.name);
      for (const expected of ["q", "sort", "dir", "page", "pageSize"]) {
        expect(names, `${path} does not document ?${expected}`).toContain(expected);
      }
    }
    const scoreParams = (doc.paths?.["/api/v1/scores"]?.get as { parameters?: { name: string }[] })?.parameters ?? [];
    expect(scoreParams.map((p) => p.name)).toContain("band");
  });

  it("documents 401/403/429 on every authenticated operation", () => {
    for (const [path, method] of IMPLEMENTED_OPERATIONS) {
      const responses = (doc.paths?.[path]?.[method] as { responses?: Record<string, unknown> })?.responses ?? {};
      for (const status of ["401", "403", "429"]) {
        expect(responses[status], `${method} ${path} does not document ${status}`).toBeDefined();
      }
    }
  });
});
