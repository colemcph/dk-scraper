/** Bits shared by the books' HTTP clients. */

/** The identity both adapters present: one ordinary Chrome tab. */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** `Cache-Control: public, max-age=30, stale-while-revalidate=60` -> 30000 */
export function parseMaxAge(cacheControl: string | null): number | null {
  const m = /(?:^|[,\s])max-age=(\d+)/i.exec(cacheControl ?? '');
  return m ? Number(m[1]) * 1000 : null;
}

/** `Age: 12` -> 12000 */
export function parseAge(age: string | null): number | null {
  if (age === null || age.trim() === '') return null;
  const n = Number(age);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : null;
}

/** `Retry-After` is either seconds or an HTTP date. Returns ms to wait, or null when absent/invalid. */
export function parseRetryAfter(retryAfter: string | null, now = Date.now()): number | null {
  if (retryAfter === null || retryAfter.trim() === '') return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(retryAfter);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** CloudFront: "Hit from cloudfront" / "RefreshHit from cloudfront" / "Miss from cloudfront". */
export function isCacheHit(xCache: string | null): boolean | null {
  if (xCache === null) return null;
  return /hit/i.test(xCache);
}
