export * as schema from "./schema.js";
export { getDb, closeDb, type Db } from "./client.js";
export { appendAudit, verifyAuditChain, GENESIS_HASH, type AuditEntry } from "./audit.js";
export {
  upsertCaseForRecord,
  getCaseByWorkflowId,
  updateCaseStatus,
  listCases,
  workflowIdForKey,
} from "./cases.js";
export type { CaseRow, NewCaseRow, AuditRow, FeedRecordRow } from "./schema.js";
