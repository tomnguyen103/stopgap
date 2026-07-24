export * as schema from "./schema.js";
export { getDb, closeDb, type Db } from "./client.js";
export {
  appendAudit,
  verifyAuditChain,
  verifyChainRows,
  computeAuditHash,
  GENESIS_HASH,
  type AuditEntry,
  type AuditScheme,
  type VerifiableRow,
  type ChainVerification,
} from "./audit.js";
export {
  anchorAuditChain,
  listAnchors,
  verifyAnchors,
  readAnchorFile,
  buildTimestampRequest,
  type AnchorVerification,
} from "./anchors.js";
export {
  upsertCaseForRecord,
  getCaseByWorkflowId,
  updateCaseStatus,
  listCases,
  listOpenMonitoringCases,
  bumpFeedMiss,
  resetFeedMiss,
  workflowIdForKey,
  MONITORING_STATUSES,
  type OpenMonitoringCase,
} from "./cases.js";
export {
  approveProtocolVersion,
  draftProtocolVersion,
  getApprovedProtocol,
  listProtocolVersions,
  type DraftProtocolInput,
} from "./protocols.js";
export {
  upsertUserByOidc,
  getUserRoles,
  getSyntheticUser,
  syntheticUserIdForLabel,
  assignRole,
  revokeRole,
  listUsers,
  setUserDisabled,
  SYNTHETIC_USER_IDS,
  type SyntheticUser,
  type UpsertUserInput,
} from "./users.js";
export { getKpis, type Kpis } from "./metrics.js";
export {
  listShadowRuns,
  listShadowRunsForClass,
  recordShadowRun,
  shadowStatsByClass,
  type ShadowClassStats,
} from "./shadow.js";
export { getLlmSpend, recordLlmSpend, utcDay, type DailySpend } from "./spend.js";
export { countDemoRunsSince, reserveDemoRun } from "./demo-runs.js";
export { feedFreshness, recordFeedRecords, type FeedFreshness } from "./feeds.js";
export type {
  DemoRunRow,
  LlmSpendRow,
  UserRow,
  NewUserRow,
  UserRoleRow,
  CaseRow,
  NewCaseRow,
  AuditRow,
  AuditAnchorRow,
  FeedRecordRow,
  ProtocolRow,
  ProtocolVersionRow,
  NewProtocolVersionRow,
  ShadowRunRow,
  NewShadowRunRow,
} from "./schema.js";
