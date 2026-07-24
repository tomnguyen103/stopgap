import { handlers } from "../../../../auth";

/**
 * Auth.js route handler (PHASE6 §6.1): serves the sign-in, callback, and sign-out endpoints
 * under `/api/auth/*`. The middleware allow-lists this path so an unauthenticated visitor can
 * actually reach the login flow it is being redirected to.
 */
export const { GET, POST } = handlers;
