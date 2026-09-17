import { BROWSER_USER_AGENT } from '../http.js';
import { errorMessage } from '../logger.js';

/**
 * Why this looks like a browser: DraftKings sits behind Akamai, which fingerprints the TLS/HTTP
 * client. Node's built-in fetch (undici) passes today while curl/python-requests get an instant
 * 403 "Access Denied" from the edge. We additionally send the headers a real tab would send and
 * replay any cookies the edge sets (ak_bmsc) so we look like one long-lived browser session.
 */

export { BROWSER_USER_AGENT };

export class DkHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly bodySnippet: string,
  ) {
    super(`DraftKings HTTP ${status} for ${url}${bodySnippet ? `: ${bodySnippet}` : ''}`);
    this.name = 'DkHttpError';
  }
}

interface StoredCookie {
  value: string;
  expiresAt: number | null;
}

/** Just enough of a cookie jar to echo back what the edge sets. */
export class CookieJar {
  private readonly cookies = new Map<string, StoredCookie>();

  ingest(setCookieHeaders: string[], now = Date.now()): void {
    for (const header of setCookieHeaders) {
      const [pair, ...attrs] = header.split(';');
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let expiresAt: number | null = null;
      for (const attr of attrs) {
        const [k, v] = attr.split('=').map((s) => s?.trim());
        if (!k) continue;
        if (k.toLowerCase() === 'max-age' && v) expiresAt = now + Number(v) * 1000;
        else if (k.toLowerCase() === 'expires' && v && expiresAt === null) {
          const t = Date.parse(v);
          if (Number.isFinite(t)) expiresAt = t;
        }
      }
      if (expiresAt !== null && expiresAt <= now) this.cookies.delete(name);
      else this.cookies.set(name, { value, expiresAt });
    }
  }

  header(now = Date.now()): string | undefined {
    const parts: string[] = [];
    for (const [name, c] of this.cookies) {
      if (c.expiresAt !== null && c.expiresAt <= now) {
        this.cookies.delete(name);
        continue;
      }
      parts.push(`${name}=${c.value}`);
    }
    return parts.length ? parts.join('; ') : undefined;
  }

  get size(): number {
    return this.cookies.size;
  }
}

export interface DkRestOptions {
  site: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export interface DkRestResponse {
  body: unknown;
  status: number;
  durationMs: number;
  fetchedAt: string;
  url: string;
}

export class DkRestClient {
  private readonly jar = new CookieJar();
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(private readonly opts: DkRestOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.baseUrl = opts.baseUrl ?? 'https://sportsbook-nash.draftkings.com';
  }

  leagueUrl(leagueId: string): string {
    return `${this.baseUrl}/api/sportscontent/${this.opts.site}/v1/leagues/${leagueId}`;
  }

  async fetchLeague(leagueId: string, signal?: AbortSignal): Promise<DkRestResponse> {
    const url = this.leagueUrl(leagueId);
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
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-CA,en;q=0.9',
        Origin: 'https://sportsbook.draftkings.com',
        Referer: 'https://sportsbook.draftkings.com/',
      };
      const cookie = this.jar.header();
      if (cookie) headers.Cookie = cookie;

      const res = await this.fetchImpl(url, {
        headers,
        signal: controller.signal,
        redirect: 'follow',
      });
      this.jar.ingest(res.headers.getSetCookie?.() ?? []);
      const text = await res.text();
      const durationMs = Date.now() - started;
      if (!res.ok) throw new DkHttpError(res.status, url, text.replace(/\s+/g, ' ').slice(0, 160));
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch (err) {
        throw new Error(
          `DraftKings returned non-JSON (${text.length} bytes): ${errorMessage(err)}`,
          {
            cause: err,
          },
        );
      }
      return {
        body,
        status: res.status,
        durationMs,
        fetchedAt: new Date(started).toISOString(),
        url,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}
