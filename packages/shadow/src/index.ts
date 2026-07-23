export { scoreAgreement, type AgreementScore, type ShadowBaseline, type ShadowProposal } from "./score.js";
export {
  PROMOTION_GATES,
  evaluatePromotion,
  type PromotionDecision,
  type PromotionStage,
  type PromotionThresholds,
} from "./promotion.js";
export { REPLAY_CORPUS, drugClassFor, type ReplayEntry } from "./corpus.js";
export { runShadowEntry } from "./run.js";
