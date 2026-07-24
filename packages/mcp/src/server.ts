import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  apiConfigured,
  caseInput,
  getCaseTool,
  getProtocolTool,
  getShadowStatsTool,
  listCasesInput,
  listCasesTool,
  resolveExceptionInput,
  resolveExceptionTool,
  reviewCaseInput,
  reviewCaseTool,
  shadowStatsInput,
} from "./tools.js";

/**
 * Stopgap MCP server (PROJECT_PLAN §4) over stdio: `pnpm --filter @stopgap/mcp serve`.
 *
 * Since PHASE6 §6.7 this process holds NO database or Temporal connection — every tool is an HTTP
 * call to the public REST API with a scoped API key (see `tools.ts`). That is why there is no
 * shutdown handler closing a connection pool any more: there is nothing to close, and a handler
 * that pretended otherwise would be dead code implying a resource this process does not own.
 *
 * Each tool's description names the scope its key must carry, and says up front when the server has
 * no key at all — an MCP client shows descriptions to the model before it calls anything, so
 * stating the requirement there turns a runtime 401 into information the model has in advance.
 */
const server = new McpServer({ name: "stopgap", version: "0.1.0" });

function asContent(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

/** Suffix appended to every description: honest about the server's own configuration state. */
const CONFIG_NOTE = apiConfigured()
  ? ""
  : " NOTE: STOPGAP_API_KEY is not set, so this server currently has no access — every call returns" +
    " instructions for issuing a key rather than data.";

server.registerTool(
  "list_cases",
  {
    title: "List shortage cases",
    description: `Recent drug-shortage cases with status and severity. Requires the \`cases:read\` scope.${CONFIG_NOTE}`,
    inputSchema: listCasesInput.shape,
  },
  async (args) => asContent(await listCasesTool(listCasesInput.parse(args))),
);

server.registerTool(
  "get_case",
  {
    title: "Get one case",
    description:
      "One case by dedup key: the durable record (status, severity, source, NDCs, timestamps). " +
      "Does NOT include in-flight agent output — the draft text and proposed alternatives live in " +
      `the running workflow, which the REST API deliberately does not reach. Requires \`cases:read\`.${CONFIG_NOTE}`,
    inputSchema: caseInput.shape,
  },
  async (args) => asContent(await getCaseTool(caseInput.parse(args))),
);

server.registerTool(
  "get_protocol",
  {
    title: "Look up a substitution protocol",
    description:
      "The approved protocol for a drug plus its version history — who authored and approved each " +
      `version and why. Requires the \`protocols:read\` scope.${CONFIG_NOTE}`,
    inputSchema: caseInput.shape,
  },
  async (args) => asContent(await getProtocolTool(caseInput.parse(args))),
);

server.registerTool(
  "get_shadow_stats",
  {
    title: "Shadow-mode aggregates",
    description:
      "Per-drug-class agreement, under-escalation, latency and cost from the shadow ledger. " +
      `Requires the \`shadow:read\` scope.${CONFIG_NOTE}`,
    inputSchema: shadowStatsInput.shape,
  },
  async () => asContent(await getShadowStatsTool()),
);

server.registerTool(
  "resolve_exception",
  {
    title: "Resolve a case blocked at the exception gate",
    description:
      "Record the substitution guidance to adopt for a case the agent could not resolve on its own. " +
      "Requires the `protocols:write` scope — a key without it is refused by the server, and the " +
      "write is attributed in the audit chain to the key and the human who issued it." +
      CONFIG_NOTE,
    inputSchema: resolveExceptionInput.shape,
  },
  async (args) => asContent(await resolveExceptionTool(resolveExceptionInput.parse(args))),
);

server.registerTool(
  "review_case",
  {
    title: "Approve, edit, or reject a drafted protocol",
    description:
      "Record the human-in-the-loop review decision on a case's agent-drafted substitution protocol: " +
      "`approve` takes the draft as written, `edit` replaces it with `editedDraft`, `reject` sends it " +
      "back with `reason`. Requires the `protocols:write` scope — a key without it is refused by the " +
      "server, and the decision is attributed in the audit chain to the key and the human who issued " +
      "it, never to a claimed reviewer name." +
      CONFIG_NOTE,
    inputSchema: reviewCaseInput.shape,
  },
  async (args) => asContent(await reviewCaseTool(reviewCaseInput.parse(args))),
);

const transport = new StdioServerTransport();
await server.connect(transport);
