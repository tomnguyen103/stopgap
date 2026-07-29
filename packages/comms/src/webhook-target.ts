/**
 * What a tenant-supplied chat webhook is allowed to point at.
 *
 * A rule's `chatWebhookUrl` is written by a director through the console and then fetched by the
 * SERVER, inside the deployment's own network. Unchecked, that is a request forger's primitive: a
 * URL of `http://169.254.169.254/latest/meta-data/iam/...` or `http://localhost:5432` makes the
 * poll issue requests to the cloud metadata service or to Postgres on the caller's behalf, and the
 * response never has to come back for the request itself to do the damage.
 *
 * Pure and dependency-free so the rule is asserted in the offline gate rather than by trying it.
 */

/** Why a webhook target was refused, phrased for the person who typed it. */
export type WebhookRefusal = string;

const ALLOWED_PROTOCOLS = new Set(["https:"]);

/**
 * Literal addresses that must never be fetched from inside the deployment.
 *
 * DNS names are NOT resolved here. Resolution is the kernel's at connect time, so a name that
 * resolves to a private address today can resolve elsewhere tomorrow, and a check that pretended
 * otherwise would be security theatre — the honest scope of this function is the literal target.
 * Egress control for names belongs in the network, and is named as the remaining gap.
 */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return true;
  // IPv6 loopback, unspecified, unique-local (fc00::/7) and link-local (fe80::/10).
  if (host === "::1" || host === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // The cloud metadata address, and the rest of link-local with it.
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * Refuse a webhook target, or return null when it is acceptable.
 *
 * HTTPS only: a webhook carries a bearer secret in its path, and plain HTTP puts it on the wire in
 * front of everything between here and the destination.
 */
export function refuseWebhookTarget(raw: string): WebhookRefusal | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "that is not a URL";
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return `webhook must be https (got ${url.protocol.replace(":", "") || "no scheme"})`;
  }
  if (url.username !== "" || url.password !== "") {
    return "webhook must not carry credentials in the URL";
  }
  if (isBlockedHost(url.hostname)) {
    return "webhook must not point inside the deployment's own network";
  }
  return null;
}
