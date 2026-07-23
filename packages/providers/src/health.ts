import { getEnv } from "@stopgap/core/env";
import type { ProviderName } from "./types.js";

/** Fetch with an abort timeout (health checks must not hang the worker). */
async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is the provider usable right now?
 * - gemini: healthy iff an API key is configured (stub otherwise).
 * - ollama: healthy iff the local daemon responds to /api/tags.
 */
export async function isProviderHealthy(name: ProviderName, timeoutMs = 1500): Promise<boolean> {
  const env = getEnv();
  if (name === "gemini") return Boolean(env.GEMINI_API_KEY);
  try {
    const res = await fetchWithTimeout(`${env.OLLAMA_BASE_URL}/api/tags`, timeoutMs);
    return res.ok;
  } catch {
    return false;
  }
}
