import { docsAudienceAllowed, DOCS_UNAUTHORIZED_MESSAGE } from "../../../lib/api-docs-gate";
import { buildOpenApiDocument } from "../../../lib/api-schemas";

/**
 * `GET /api/v1/docs` (PHASE6 §6.7) — human-readable API documentation.
 *
 * NO EXTERNAL REQUESTS. The page is rendered here, from the OpenAPI document object, and loads no
 * script, stylesheet, font or image from anywhere. It previously mounted Swagger UI from a pinned
 * unpkg URL, which was wrong twice over. Pinning a VERSION is not pinning CONTENT: without an
 * `integrity` hash, whatever unpkg serves for that path executes — and it executes on the console's
 * own origin, the origin that holds the admin's Auth.js session cookie, in a product that ships no
 * CSP to contain it. A docs page is not worth a same-origin script-execution primitive sourced from
 * a third party. The second failure was operational: this platform is deployed inside hospitals, and
 * an air-gapped network would simply never fetch the bundle, leaving an operator with a page that
 * silently never finished loading. Rendering from the document removes both problems at once, and
 * the cost is only that this page is plainer than Swagger UI.
 *
 * SESSION-GATED, viewer minimum (§6.7: "admin or viewer-gated") — see `api-docs-gate.ts` for who is
 * let through and why an unconfigured or demo deployment still answers.
 *
 * A refusal here is HTML, not the `{ error, message }` JSON envelope its sibling
 * `/api/v1/openapi.json` uses. The audiences differ and so should the bodies: this route's caller is
 * a person who typed a URL into a browser, and a browser renders a JSON refusal as an unstyled blob
 * of punctuation with no way forward. HTML lets the 401 say what happened and link to the sign-in
 * the reader needs. The machine-facing spec route keeps JSON for exactly the mirrored reason.
 *
 * The content is derived from the same document the spec route serves, which is derived from the
 * same Zod schemas the routes validate with — so this page cannot describe an endpoint differently
 * from how that endpoint behaves.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** HTTP methods this renderer walks, in the order an operation list reads best. */
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/**
 * Escape every value that reaches the page. Schema descriptions and summaries are authored in this
 * repo, but they are ordinary prose containing backticks and angle brackets, and a docs page that
 * interpolated them raw would be one PR away from injecting markup into its own output.
 */
function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `#/components/schemas/CaseList` → `CaseList`; anything else renders as-is. */
function refName(schema: unknown): string | undefined {
  const ref = (schema as { $ref?: string } | undefined)?.$ref;
  return ref?.startsWith("#/components/schemas/")
    ? ref.slice("#/components/schemas/".length)
    : undefined;
}

/** The JSON schema behind an OpenAPI `content` block, named if it is a `$ref`, else "inline". */
function contentSchemaLabel(content: unknown): string {
  const schema = (content as { "application/json"?: { schema?: unknown } } | undefined)?.[
    "application/json"
  ]?.schema;
  if (schema === undefined) return "—";
  const name = refName(schema);
  return name
    ? `<a href="#schema-${esc(name)}"><code>${esc(name)}</code></a>`
    : "<code>inline</code>";
}

/** A one-line type summary for a JSON-schema node — enough to read a field list without a viewer. */
function typeLabel(schema: Record<string, unknown> | undefined): string {
  if (!schema) return "any";
  const name = refName(schema);
  if (name) return name;
  if (Array.isArray(schema.enum)) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.type === "array") return `${typeLabel(schema.items as Record<string, unknown>)}[]`;
  if (Array.isArray(schema.oneOf)) {
    return (schema.oneOf as Record<string, unknown>[]).map((s) => typeLabel(s)).join(" | ");
  }
  if (Array.isArray(schema.anyOf)) {
    return (schema.anyOf as Record<string, unknown>[]).map((s) => typeLabel(s)).join(" | ");
  }
  return String(schema.type ?? "object");
}

function renderParameters(parameters: unknown): string {
  const list = Array.isArray(parameters) ? (parameters as Record<string, unknown>[]) : [];
  if (list.length === 0) return "";
  const rows = list
    .map((p) => {
      const required = p.required === true ? "required" : "optional";
      const description =
        (p.schema as Record<string, unknown> | undefined)?.description ?? p.description ?? "";
      return `<tr><td><code>${esc(p.name)}</code></td><td>${esc(p.in)}</td><td><code>${esc(
        typeLabel(p.schema as Record<string, unknown>),
      )}</code></td><td>${esc(required)}</td><td>${esc(description)}</td></tr>`;
    })
    .join("");
  return `<h4>Parameters</h4><table><thead><tr><th>Name</th><th>In</th><th>Type</th><th></th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderResponses(responses: unknown): string {
  const entries = Object.entries((responses ?? {}) as Record<string, Record<string, unknown>>);
  if (entries.length === 0) return "";
  const rows = entries
    .map(
      ([status, response]) =>
        `<tr><td><code>${esc(status)}</code></td><td>${contentSchemaLabel(response.content)}</td><td>${esc(
          response.description,
        )}</td></tr>`,
    )
    .join("");
  return `<h4>Responses</h4><table><thead><tr><th>Status</th><th>Body</th><th>Meaning</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderOperation(path: string, method: string, operation: Record<string, unknown>): string {
  const scope = operation["x-required-scope"];
  const requestBody = (operation.requestBody as { content?: unknown } | undefined)?.content;
  return `<section class="op">
  <h3><span class="method method-${esc(method)}">${esc(method.toUpperCase())}</span> <code>${esc(path)}</code></h3>
  <p class="summary">${esc(operation.summary)}</p>
  ${scope ? `<p class="scope">Required scope: <code>${esc(scope)}</code></p>` : ""}
  <p class="desc">${esc(operation.description)}</p>
  ${requestBody ? `<h4>Request body</h4><p>${contentSchemaLabel(requestBody)}</p>` : ""}
  ${renderParameters(operation.parameters)}
  ${renderResponses(operation.responses)}
</section>`;
}

/** The field table for one object schema, or "" when the node has no properties of its own. */
function renderFieldTable(schema: Record<string, unknown>): string {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const rows = Object.entries(properties)
    .map(
      ([field, node]) =>
        `<tr><td><code>${esc(field)}</code></td><td><code>${esc(typeLabel(node))}</code></td><td>${
          required.has(field) ? "required" : "optional"
        }</td><td>${esc(node.description ?? "")}</td></tr>`,
    )
    .join("");
  if (!rows) return "";
  return `<table><thead><tr><th>Field</th><th>Type</th><th></th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/**
 * Render one named component schema.
 *
 * A UNION (a Zod discriminated union, which becomes `oneOf`) gets one field table per variant rather
 * than a single collapsed row. `ReviewDecision` is the case that forced it: its variants have
 * DIFFERENT required fields, and a reader who cannot see that `edit` requires `editedDraft` while
 * `reject` requires `reason` has to discover it by getting a 400 back.
 */
function renderSchema(name: string, schema: Record<string, unknown>): string {
  const variants = (schema.oneOf ?? schema.anyOf) as Record<string, unknown>[] | undefined;
  const own = renderFieldTable(schema);
  const body = own
    ? own
    : Array.isArray(variants)
      ? variants
          .map(
            (variant, i) =>
              `<h4>Variant ${i + 1}</h4>${renderFieldTable(variant) || `<p class="desc">${esc(typeLabel(variant))}</p>`}`,
          )
          .join("")
      : `<p class="desc">${esc(typeLabel(schema))}</p>`;
  return `<section class="op" id="schema-${esc(name)}">
  <h3><code>${esc(name)}</code></h3>
  ${schema.description ? `<p class="desc">${esc(schema.description)}</p>` : ""}
  ${body}
</section>`;
}

function renderPage(): string {
  const doc = buildOpenApiDocument() as unknown as {
    info: { title: string; version: string; description?: string };
    paths?: Record<string, Record<string, unknown>>;
    components?: { schemas?: Record<string, Record<string, unknown>> };
  };

  const operations = Object.entries(doc.paths ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([path, item]) =>
      METHODS.filter((m) => item[m] !== undefined).map((m) =>
        renderOperation(path, m, item[m] as Record<string, unknown>),
      ),
    )
    .join("\n");

  const schemas = Object.entries(doc.components?.schemas ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, schema]) => renderSchema(name, schema))
    .join("\n");

  // The description is prose with blank lines; render paragraphs so it stays readable.
  const intro = (doc.info.description ?? "")
    .split("\n\n")
    .map((p) => `<p>${esc(p)}</p>`)
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(doc.info.title)}</title>
    <style>
      :root { --bg:#0b0e14; --panel:#141a24; --line:#232c3a; --text:#e6edf3; --muted:#8b98a9; --accent:#4da3ff; }
      body { margin:0; background:var(--bg); color:var(--text);
             font-family: ui-sans-serif, system-ui, sans-serif; line-height:1.6; }
      .wrap { max-width: 900px; margin: 0 auto; padding: 32px 24px 64px; }
      h1 { margin: 0 0 4px; font-size: 22px; }
      h2 { margin: 40px 0 12px; font-size: 15px; text-transform: uppercase;
           letter-spacing: 0.6px; color: var(--muted); }
      h3 { margin: 0 0 8px; font-size: 15px; }
      h4 { margin: 18px 0 6px; font-size: 12px; text-transform: uppercase;
           letter-spacing: 0.4px; color: var(--muted); }
      p { margin: 0 0 8px; }
      code { font-family: ui-monospace, monospace; font-size: 13px; }
      a { color: var(--accent); }
      .op { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
            padding: 18px 20px; margin-bottom: 16px; }
      .method { display:inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px;
                border: 1px solid var(--line); color: var(--accent); }
      .method-post { color: #ffa94d; border-color: #ffa94d; }
      .summary { font-weight: 600; }
      .scope, .desc { color: var(--muted); font-size: 13px; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line);
               vertical-align: top; }
      th { color: var(--muted); font-weight: 600; font-size: 11px;
           text-transform: uppercase; letter-spacing: 0.4px; }
      .intro { color: var(--muted); font-size: 13px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>${esc(doc.info.title)} <span class="scope">v${esc(doc.info.version)}</span></h1>
      <div class="intro">${intro}</div>
      <p class="intro">
        The machine-readable contract is at
        <a href="/api/v1/openapi.json"><code>/api/v1/openapi.json</code></a> — point any OpenAPI
        client generator at it. This page is rendered from that same document and loads nothing
        from outside this deployment.
      </p>
      <h2>Operations</h2>
      ${operations}
      <h2>Schemas</h2>
      ${schemas}
    </div>
  </body>
</html>
`;
}

const UNAUTHORIZED_PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Sign in required</title></head>
  <body style="font-family: ui-sans-serif, system-ui, sans-serif; padding: 32px; line-height: 1.6;">
    <h1 style="font-size: 20px;">Sign in required</h1>
    <p>${DOCS_UNAUTHORIZED_MESSAGE}</p>
    <p><a href="/">Go to the console</a></p>
  </body>
</html>
`;

export async function GET(): Promise<Response> {
  const headers = { "content-type": "text/html; charset=utf-8" };
  if (!(await docsAudienceAllowed())) {
    return new Response(UNAUTHORIZED_PAGE, { status: 401, headers });
  }
  return new Response(renderPage(), { status: 200, headers });
}
