/**
 * Validation of the smoke gate target.
 *
 * The gate is destructive and operator-driven, but its target must still be explicit:
 * an unvalidated SMOKE_BASE_URL would let the script issue requests to an arbitrary
 * host (SSRF). Loopback hosts are allowed by default because the gate exists to test
 * the local contour; any other host must be named in SMOKE_ALLOWED_HOSTS, so a remote
 * contour is reachable only on purpose.
 */

const DEFAULT_BASE_URL = 'http://localhost:8000';

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Resolves the base URL for the gate: validates the scheme, rejects embedded
 * credentials, and restricts non-loopback hosts to the SMOKE_ALLOWED_HOSTS list.
 * Returns the normalized origin; a path in the input is deliberately dropped,
 * because the gate appends its own endpoint paths.
 *
 * @param raw Value of SMOKE_BASE_URL; falls back to the local contour default.
 * @param allowedHosts Value of SMOKE_ALLOWED_HOSTS: extra host names, comma-separated.
 * @returns The base URL without a trailing path, ready to be joined with endpoints.
 * @throws Error naming the offending part when the value is not a usable contour URL.
 */
export function resolveSmokeBaseUrl(raw: string | undefined, allowedHosts: string | undefined): string {
  const candidate = raw ?? DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`SMOKE_BASE_URL is not a valid URL: ${candidate}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`SMOKE_BASE_URL scheme must be http or https, got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error('SMOKE_BASE_URL must not carry credentials inside the URL');
  }
  // Node keeps IPv6 brackets in `hostname` ("[::1]"); the loopback set is bracket-free.
  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!LOOPBACK_HOSTS.has(host)) {
    const extra = (allowedHosts ?? '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0);
    if (!extra.includes(host)) {
      throw new Error(
        `SMOKE_BASE_URL host "${host}" is not allowed; ` +
          'loopback needs no permission, any other host must be listed in SMOKE_ALLOWED_HOSTS',
      );
    }
  }
  return url.origin;
}
