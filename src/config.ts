/** Static configuration: proxy credentials, paths, headers. */
import path from 'node:path';

export interface ProxyCreds {
  host: string;
  port: number;
  user: string;
  pass: string;
}

/**
 * User-supplied residential proxy — used to bypass TikTok's WAF/captcha and the
 * Akamai bot-protection on the video CDN (datacenter IPs get blocked; a fresh
 * residential IP per request also dodges per-IP rate-limiting).
 *
 * No credentials are shipped in source: the user adds their own at runtime via
 * the menu (option [6]) or these env vars. An empty `host` means "not set",
 * in which case all proxy attempts are skipped and we stay direct.
 */
export const PROXY: ProxyCreds = {
  host: process.env.TIKTOK_PROXY_HOST ?? '',
  port: Number(process.env.TIKTOK_PROXY_PORT ?? 0) || 0,
  user: process.env.TIKTOK_PROXY_USER ?? '',
  pass: process.env.TIKTOK_PROXY_PASS ?? '',
};

/** Whether a usable proxy (host + port) has been configured. */
export function proxyConfigured(): boolean {
  return Boolean(PROXY.host && PROXY.port);
}

/**
 * Set the proxy from a `host:port:user:pass` string (the format most providers
 * hand out, e.g. `1.2.3.4:5432:user:pass`) or a full `http://user:pass@host:port`
 * URL. Mutates {@link PROXY}. Returns an error message on bad input, else null.
 */
export function setProxyFromString(input: string): string | null {
  const s = input.trim();
  if (!s) return 'no input';

  // Full URL form: http://user:pass@host:port
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return 'invalid proxy URL';
    }
    const port = Number(u.port);
    if (!u.hostname || !port) return 'proxy URL needs a host and port';
    PROXY.host = u.hostname;
    PROXY.port = port;
    PROXY.user = decodeURIComponent(u.username);
    PROXY.pass = decodeURIComponent(u.password);
    return null;
  }

  // host:port[:user:pass]  (user/pass optional; pass may itself contain ':')
  const parts = s.split(':');
  if (parts.length < 2) return 'expected host:port:user:pass';
  const host = parts[0]!.trim();
  const port = Number(parts[1]);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return 'invalid host or port';
  }
  PROXY.host = host;
  PROXY.port = port;
  PROXY.user = parts[2] ?? '';
  PROXY.pass = parts.slice(3).join(':');
  return null;
}

/** Proxy as an `http://user:pass@host:port` URL (consumed by the proxy agent). */
export function proxyUrl(): string {
  if (!proxyConfigured()) throw new Error('no proxy configured (add one via the menu)');
  const { user, pass, host, port } = PROXY;
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';
  return `http://${auth}${host}:${port}`;
}

/** A redacted form safe to print in logs. */
export function proxyDisplay(): string {
  if (!proxyConfigured()) return 'not set';
  return `${PROXY.host}:${PROXY.port}${PROXY.user ? ` (user ${PROXY.user})` : ''}`;
}

/**
 * Scrub credentials from any string before logging — strips inline URL
 * userinfo (`//user:pass@`) and any literal occurrence of the proxy password.
 * proxy-agent errors often echo the full proxy URL.
 */
export function redact(s: string): string {
  let out = s.replace(/\/\/[^/@\s:]+:[^/@\s]+@/g, '//***:***@');
  if (PROXY.pass) out = out.split(PROXY.pass).join('***');
  return out;
}

/** Default download location (override with TIKTOK_DL_DIR or the `-o` flag). */
export const DOWNLOAD_DIR =
  process.env.TIKTOK_DL_DIR ?? path.resolve(process.cwd(), 'downloads');

/** Mutable runtime settings (e.g. `-o <dir>` overrides downloadDir). */
export const runtime: { downloadDir: string } = { downloadDir: DOWNLOAD_DIR };

/** Desktop Chrome UA — used for webpage scraping of image posts. */
export const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Network timeout for plain HTTP(S) requests (ms). Fail fast on a flaky proxy. */
export const HTTP_TIMEOUT_MS = Number(process.env.TIKTOK_HTTP_TIMEOUT_MS ?? 20_000);
