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
export {
  approveProtocolVersion,
  draftProtocolVersion,
  getApprovedProtocol,
  listProtocolVersions,
  type DraftProtocolInput,
} from "./protocols.js";
export {
  listShadowRuns,
  listShadowRunsForClass,
  recordShadowRun,
  shadowStatsByClass,
  type ShadowClassStats,
} from "./shadow.js";
export type {
  CaseRow,
  NewCaseRow,
  AuditRow,
  FeedRecordRow,
  ProtocolRow,
  ProtocolVersionRow,
  NewProtocolVersionRow,
  ShadowRunRow,
  NewShadowRunRow,
} from "./schema.js";
