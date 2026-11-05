import { createHash } from 'node:crypto';

/** Bump only with a documented backfill; stored digests are comparable only within one version. */
export const EVIDENCE_FINGERPRINT_VERSION = 'v1';
const TRACKING = /^(utm_[a-z0-9_]+|fbclid|gclid|mc_cid|mc_eid)$/i;

/**
 * Canonical form of an already-validated https evidence reference, used only to compare references.
 * Removes cosmetic differences (host case, leading www., default port, in-page fragment, trailing slash,
 * tracking parameters, parameter order) and keeps path case and meaningful parameters, so two
 * different resources are never matched. A hash-routed single-page-app route (`#/u/alice`, `#!/u/alice`) names
 * a resource, so it is kept. A match is a review hint, never proof of copying.
 */
export function normalizeEvidenceReference(reference: string): string {
  const url = new URL(reference);
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const port = url.port && url.port !== '443' ? ':' + url.port : '';
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') || '/' : url.pathname;
  const params = [...url.searchParams.entries()]
    .filter(([name]) => !TRACKING.test(name))
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1));
  const query = params.length ? '?' + new URLSearchParams(params).toString() : '';
  const route = /^#!?\//.test(url.hash) ? url.hash.replace(/\/+$/, '') : '';
  return `https://${host}${port}${path}${query}${route}`;
}

/**
 * False for a bare site root (`https://github.com/`): two claimants citing the same site name no shared resource, so
 * flagging them against each other would be noise. A path, a query or a hash route makes a reference distinctive.
 */
export function isDistinctiveEvidenceReference(reference: string): boolean {
  const { pathname, search, hash } = new URL(normalizeEvidenceReference(reference));
  return pathname !== '/' || search !== '' || hash !== '';
}

export function fingerprintEvidenceReference(reference: string): string {
  return createHash('sha256')
    .update(`${EVIDENCE_FINGERPRINT_VERSION}\n${normalizeEvidenceReference(reference)}`, 'utf8')
    .digest('hex');
}
