import { BROWSER_USER_AGENT, isCacheHit, parseAge, parseMaxAge, parseRetryAfter } from '../http.js';
import { errorMessage } from '../logger.js';

/**
 * FanDuel's public page API, as their own web client calls it:
 *
 *   GET https://sbapi.on.sportsbook.fanduel.ca/api/content-managed-page
 *         ?page=CUSTOM&customPageId=nfl&pbHorizontal=false&_ak=<public key>&timezone=America/Toronto
 *
 * No login, no cookie, no TLS fingerprinting (curl gets the same 200 as Node). The `_ak` key is a
 * constant baked into their JavaScript bundle. What bounds freshness is CloudFront in front of
 * it: `Cache-Control: public, max-age=30, stale-while-revalidate=60`, so the copy we get can be
 * up to 30 s old whatever the poll rate. Two things make polling both cheap and as fast as that
 * cache allows:
 *
 *  - `If-None-Match` with the ETag they send: an unchanged page costs a ~200-byte 304 in ~10 ms.
 *  - The `Age` header: we know exactly when the edge copy can next change, so the adapter sleeps
 *    until then and polls fast only around that boundary (see `nextPollDelayMs` in adapter.ts).
 *
 * `bypassCache` appends a unique query parameter so every request reaches the origin (measured:
 * "Miss from cloudfront", ~300 ms). It is off by default because each poll then costs FanDuel
 * an origin request instead of an edge hit.
 */

export class FdHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly bodySnippet: string,
    /** From `Retry-After` on 429/503, when present. */
    public readonly retryAfterMs: number | null = null,
  ) {
    super(`FanDuel HTTP ${status} for ${url}${bodySnippet ? `: ${bodySnippet}` : ''}`);
    this.name = 'FdHttpError';
  }
}

export interface FdRestOptions {
  /** FanDuel region/state code: `on` = Ontario. */
  region: string;
  /** The public `_ak` key from FanDuel's bundle. */
  apiKey: string;
  timezone: string;
  /** Override the API origin (chaos tests). Default: https://sbapi.{region}.sportsbook.fanduel.ca/api */
  baseUrl?: string;
  /** `Vary: Origin` is part of the CDN cache key; using the real site origin shares the warm entry. */
  origin?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  bypassCache?: boolean;
}

export interface FdPageResponse {
  status: number;
  /** Parsed JSON; absent on 304. */
  body?: unknown;
  notModified: boolean;
  durationMs: number;
  /** When the request was started (our clock, ISO). */
  fetchedAt: string;
  url: string;
  etag: string | null;
  ageMs: number | null;
  maxAgeMs: number | null;
  cacheHit: boolean | null;
  /** The response `Date` header (upstream clock, ms epoch). */
  dateMs: number | null;
}

export class FdRestClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly origin: string;
  private etag: string | null = null;

  constructor(private readonly opts: FdRestOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.baseUrl = opts.baseUrl ?? `https://sbapi.${opts.region}.sportsbook.fanduel.ca/api`;
    this.origin = opts.origin ?? 'https://sportsbook.fanduel.ca';
  }

  /** The ETag we will send as `If-None-Match` on the next request. */
  get lastEtag(): string | null {
    return this.etag;
  }

  pageUrl(pageId: string): string {
    const q = new URLSearchParams({
      page: 'CUSTOM',
      customPageId: pageId,
      pbHorizontal: 'false',
      _ak: this.opts.apiKey,
      timezone: this.opts.timezone,
    });
    return `${this.baseUrl}/content-managed-page?${q.toString()}`;
  }

  async fetchPage(pageId: string, signal?: AbortSignal): Promise<FdPageResponse> {
    const base = this.pageUrl(pageId);
    const url = this.opts.bypassCache ? `${base}&_=${Date.now()}` : base;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`timeout after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );
    const onOuterAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onOuterAbort, { once: true });

    const started = Date.now();
    try {
      const headers: Record<string, string> = {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'application/json',
        'Accept-Language': 'en-CA,en;q=0.9',
        Origin: this.origin,
        Referer: `${this.origin}/`,
      };
      if (this.etag) headers['If-None-Match'] = this.etag;

      const res = await this.fetchImpl(url, {
        headers,
        signal: controller.signal,
        redirect: 'follow',
      });
      const durationMs = Date.now() - started;
      const meta = {
        durationMs,
        fetchedAt: new Date(started).toISOString(),
        url: base,
        etag: res.headers.get('etag'),
        ageMs: parseAge(res.headers.get('age')),
        maxAgeMs: parseMaxAge(res.headers.get('cache-control')),
        cacheHit: isCacheHit(res.headers.get('x-cache')),
        dateMs: parseDate(res.headers.get('date')),
      };

      if (res.status === 304) {
        await res.arrayBuffer().catch(() => undefined);
        return { status: 304, notModified: true, ...meta };
      }
      const text = await res.text();
      if (!res.ok) {
        throw new FdHttpError(
          res.status,
          base,
          text.replace(/\s+/g, ' ').slice(0, 160),
          parseRetryAfter(res.headers.get('retry-after')),
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch (err) {
        throw new Error(`FanDuel returned non-JSON (${text.length} bytes): ${errorMessage(err)}`, {
          cause: err,
        });
      }
      if (meta.etag) this.etag = meta.etag;
      return { status: res.status, body, notModified: false, ...meta };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}

function parseDate(header: string | null): number | null {
  if (!header) return null;
  const t = Date.parse(header);
  return Number.isFinite(t) ? t : null;
}
