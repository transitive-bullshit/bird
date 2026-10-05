/**
 * Browser cookie extraction for Twitter authentication.
 * Delegates to @steipete/sweet-cookie for Safari/Chrome/Firefox reads.
 */

import { type Cookie, getCookies } from '@steipete/sweet-cookie';

export interface TwitterCookies {
  authToken: string | null;
  ct0: string | null;
  cookieHeader: string | null;
  source: string | null;
}

export interface CookieExtractionResult {
  cookies: TwitterCookies;
  warnings: string[];
}

export type CookieSource = 'safari' | 'chrome' | 'firefox';

const TWITTER_COOKIE_NAMES = ['auth_token', 'ct0'] as const;
const TWITTER_URL = 'https://x.com/';
const TWITTER_ORIGINS: string[] = ['https://x.com/', 'https://twitter.com/'];
const DEFAULT_COOKIE_TIMEOUT_MS = 30_000;
const LEADING_DOT_REGEX = /^\./;

function normalizeValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cookieHeader(authToken: string, ct0: string): string {
  return `auth_token=${authToken}; ct0=${ct0}`;
}

function buildEmpty(): TwitterCookies {
  return { authToken: null, ct0: null, cookieHeader: null, source: null };
}

function readEnvCookie(cookies: TwitterCookies, keys: readonly string[], field: 'authToken' | 'ct0'): void {
  if (cookies[field]) {
    return;
  }
  for (const key of keys) {
    const value = normalizeValue(process.env[key]);
    if (!value) {
      continue;
    }
    cookies[field] = value;
    if (!cookies.source) {
      cookies.source = `env ${key}`;
    }
    break;
  }
}

function resolveSources(cookieSource?: CookieSource | CookieSource[]): CookieSource[] {
  if (Array.isArray(cookieSource)) {
    return cookieSource;
  }
  if (cookieSource) {
    return [cookieSource];
  }
  return ['safari', 'chrome', 'firefox'];
}

function labelForSource(source: CookieSource, profile?: string): string {
  if (source === 'safari') {
    return 'Safari';
  }
  if (source === 'chrome') {
    return profile ? `Chrome profile "${profile}"` : 'Chrome default profile';
  }
  return profile ? `Firefox profile "${profile}"` : 'Firefox default profile';
}

function pickCookiePair(cookies: Cookie[]): { authToken: string; ct0: string } | undefined {
  const groups = new Map<string, { domain: string; authToken?: string; ct0?: string }>();
  for (const cookie of cookies) {
    const value = normalizeValue(cookie.value);
    if (!value || (cookie.name !== 'auth_token' && cookie.name !== 'ct0')) {
      continue;
    }
    const domain = (cookie.domain ?? '').toLowerCase().replace(LEADING_DOT_REGEX, '');
    const key = JSON.stringify([domain, cookie.source?.browser, cookie.source?.profile, cookie.source?.storeId]);
    const group = groups.get(key) ?? { domain };
    const field = cookie.name === 'auth_token' ? 'authToken' : 'ct0';
    group[field] ??= value;
    groups.set(key, group);
  }
  const rank = (domain: string) => (domain === 'x.com' ? 0 : domain === 'twitter.com' ? 1 : 2);
  const candidates = [...groups.values()].sort((a, b) => rank(a.domain) - rank(b.domain));
  for (const { authToken, ct0 } of candidates) {
    if (authToken && ct0) {
      return { authToken, ct0 };
    }
  }
  return undefined;
}

async function readTwitterCookiesFromBrowser(options: {
  source: CookieSource;
  chromeProfile?: string;
  firefoxProfile?: string;
  cookieTimeoutMs?: number;
}): Promise<CookieExtractionResult> {
  const warnings: string[] = [];
  const out = buildEmpty();

  const { cookies, warnings: providerWarnings } = await getCookies({
    url: TWITTER_URL,
    origins: TWITTER_ORIGINS,
    names: [...TWITTER_COOKIE_NAMES],
    browsers: [options.source],
    mode: 'merge',
    chromeProfile: options.chromeProfile,
    firefoxProfile: options.firefoxProfile,
    timeoutMs: options.cookieTimeoutMs,
  });
  warnings.push(...providerWarnings);

  // Sweet Cookie can return multiple Chromium stores; keep each session's pair together.
  const pair = pickCookiePair(cookies);
  out.authToken = pair?.authToken ?? null;
  out.ct0 = pair?.ct0 ?? null;

  if (out.authToken && out.ct0) {
    out.cookieHeader = cookieHeader(out.authToken, out.ct0);
    out.source = labelForSource(
      options.source,
      options.source === 'chrome' ? options.chromeProfile : options.firefoxProfile,
    );
    return { cookies: out, warnings };
  }

  if (options.source === 'safari') {
    warnings.push('No Twitter cookies found in Safari. Make sure you are logged into x.com in Safari.');
  } else if (options.source === 'chrome') {
    warnings.push('No Twitter cookies found in Chrome. Make sure you are logged into x.com in Chrome.');
  } else {
    warnings.push(
      'No Twitter cookies found in Firefox. Make sure you are logged into x.com in Firefox and the profile exists.',
    );
  }

  return { cookies: out, warnings };
}

export async function extractCookiesFromSafari(): Promise<CookieExtractionResult> {
  return readTwitterCookiesFromBrowser({ source: 'safari' });
}

export async function extractCookiesFromChrome(profile?: string): Promise<CookieExtractionResult> {
  return readTwitterCookiesFromBrowser({ source: 'chrome', chromeProfile: profile });
}

export async function extractCookiesFromFirefox(profile?: string): Promise<CookieExtractionResult> {
  return readTwitterCookiesFromBrowser({ source: 'firefox', firefoxProfile: profile });
}

/**
 * Resolve Twitter credentials from multiple sources.
 * Priority: CLI args > environment variables > browsers (ordered).
 */
export async function resolveCredentials(options: {
  authToken?: string;
  ct0?: string;
  cookieSource?: CookieSource | CookieSource[];
  chromeProfile?: string;
  firefoxProfile?: string;
  cookieTimeoutMs?: number;
}): Promise<CookieExtractionResult> {
  const warnings: string[] = [];
  const cookies = buildEmpty();
  const cookieTimeoutMs =
    typeof options.cookieTimeoutMs === 'number' &&
    Number.isFinite(options.cookieTimeoutMs) &&
    options.cookieTimeoutMs > 0
      ? options.cookieTimeoutMs
      : process.platform === 'darwin'
        ? DEFAULT_COOKIE_TIMEOUT_MS
        : undefined;

  if (options.authToken) {
    cookies.authToken = options.authToken;
    cookies.source = 'CLI argument';
  }
  if (options.ct0) {
    cookies.ct0 = options.ct0;
    if (!cookies.source) {
      cookies.source = 'CLI argument';
    }
  }

  readEnvCookie(cookies, ['AUTH_TOKEN', 'TWITTER_AUTH_TOKEN'], 'authToken');
  readEnvCookie(cookies, ['CT0', 'TWITTER_CT0'], 'ct0');

  if (cookies.authToken && cookies.ct0) {
    cookies.cookieHeader = cookieHeader(cookies.authToken, cookies.ct0);
    return { cookies, warnings };
  }

  const sourcesToTry = resolveSources(options.cookieSource);
  for (const source of sourcesToTry) {
    const res = await readTwitterCookiesFromBrowser({
      source,
      chromeProfile: options.chromeProfile,
      firefoxProfile: options.firefoxProfile,
      cookieTimeoutMs,
    });
    warnings.push(...res.warnings);
    if (res.cookies.authToken && res.cookies.ct0) {
      return { cookies: res.cookies, warnings };
    }
  }

  if (!cookies.authToken) {
    warnings.push(
      'Missing auth_token - provide via --auth-token, AUTH_TOKEN env var, or login to x.com in Safari/Chrome/Firefox',
    );
  }
  if (!cookies.ct0) {
    warnings.push('Missing ct0 - provide via --ct0, CT0 env var, or login to x.com in Safari/Chrome/Firefox');
  }
  if (cookies.authToken && cookies.ct0) {
    cookies.cookieHeader = cookieHeader(cookies.authToken, cookies.ct0);
  }

  return { cookies, warnings };
}
