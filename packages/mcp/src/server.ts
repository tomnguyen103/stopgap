import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeDb } from "@stopgap/db";
import {
  caseInput,
  getCaseTool,
  getProtocolTool,
  listCasesInput,
  listCasesTool,
  reviewCaseTool,
  reviewInput,
  reviewToolEnabled,
} from "./tools.js";

/**
 * Stopgap MCP server (PROJECT_PLAN §4) over stdio: `pnpm --filter @stopgap/mcp serve`.
 * Exposes the pipeline to an MCP client — query cases, look up organizational memory, and
 * submit a pharmacist decision. See `tools.ts` for why the mutation surface stops there.
 */
const server = new McpServer({ name: "stopgap", version: "0.1.0" });

function asContent(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

server.registerTool(
  "list_cases",
  {
    title: "List shortage cases",
    description: "Recent drug-shortage cases with status and severity.",
    inputSchema: listCasesInput.shape,
  },
  async (args) => asContent(await listCasesTool(listCasesInput.parse(args))),
);

server.registerTool(
  "get_case",
  {
    title: "Get one case",
    description:
      "One case by dedup key, combining the durable record with live workflow state (draft, alternatives, exception reason).",
    inputSchema: caseInput.shape,
  },
  async (args) => asContent(await getCaseTool(caseInput.parse(args))),
);

server.registerTool(
  "get_protocol",
  {
    title: "Look up a substitution protocol",
    description:
      "The approved protocol for a drug plus its version history — who authored and approved each version and why.",
    inputSchema: caseInput.shape,
  },
  async (args) => asContent(await getProtocolTool(caseInput.parse(args))),
);

server.registerTool(
  "review_case",
  {
    title: "Submit a pharmacist review decision",
    description:
      "Approve, approve-with-edits, or reject the drafted protocol for a case waiting at the " +
      `human review gate. ${reviewToolEnabled() ? "Enabled." : "DISABLED — set STOPGAP_MCP_ALLOW_REVIEW=1 to allow it."}`,
    inputSchema: reviewInput.shape,
  },
  async (args) => asContent(await reviewCaseTool(reviewInput.parse(args))),
);

const transport = new StdioServerTransport();
await server.connect(transport);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void closeDb().finally(() => {
      process.exit(0);
    });
  });
}
