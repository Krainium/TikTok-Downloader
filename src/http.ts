/**
 * Thin HTTP(S) layer built on node core modules with optional proxy support.
 *
 * Used for everything: scraping post webpages, hitting the mobile API, and
 * streaming video/image/audio files to disk with a live byte counter.
 */
import http from 'node:http';
import https from 'node:https';
import { createWriteStream } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import zlib from 'node:zlib';
import { URL } from 'node:url';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { proxyUrl, WEB_UA, HTTP_TIMEOUT_MS } from './config.js';

export interface RequestOptions {
  headers?: Record<string, string>;
  proxy?: boolean;
  timeoutMs?: number;
  maxRedirects?: number;
}

interface OpenResult {
  res: http.IncomingMessage;
  finalUrl: string;
}

function agentFor(useProxy: boolean) {
  return useProxy ? new HttpsProxyAgent(proxyUrl()) : undefined;
}

/** Open a GET stream, following redirects. Resolves with the live response. */
function openStream(url: string, opts: RequestOptions = {}): Promise<OpenResult> {
  const {
    headers = {},
    proxy = false,
    timeoutMs = HTTP_TIMEOUT_MS,
    maxRedirects = 6,
  } = opts;

  const attempt = (target: string, redirectsLeft: number): Promise<OpenResult> =>
    new Promise<OpenResult>((resolve, reject) => {
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        return reject(new Error(`Invalid URL: ${target}`));
      }
      const transport = parsed.protocol === 'http:' ? http : https;

      const req = transport.request(
        parsed,
        {
          method: 'GET',
          agent: agentFor(proxy),
          headers: {
            'User-Agent': WEB_UA,
            Accept: '*/*',
            'Accept-Encoding': 'identity',
            ...headers,
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          // Follow redirects.
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume(); // drain
            if (redirectsLeft <= 0) {
              return reject(new Error(`Too many redirects from ${url}`));
            }
            const next = new URL(res.headers.location, parsed).toString();
            resolve(attempt(next, redirectsLeft - 1));
            return;
          }
          resolve({ res, finalUrl: parsed.toString() });
        },
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Request timed out after ${timeoutMs}ms: ${target}`));
      });
      req.on('error', reject);
      req.end();
    });

  return attempt(url, maxRedirects);
}

/** Follow redirects and return the final URL without reading the body. */
export async function resolveFinalUrl(url: string, opts: RequestOptions = {}): Promise<string> {
  const { res, finalUrl } = await openStream(url, opts);
  res.destroy();
  return finalUrl;
}

/**
 * Open a live GET stream (redirects followed). Caller owns the returned
 * `res` stream — pipe it somewhere and consume/destroy it. Used by the web
 * server to proxy thumbnails straight to the browser without buffering.
 */
export async function httpStream(
  url: string,
  opts: RequestOptions = {},
): Promise<{ res: http.IncomingMessage; status: number; finalUrl: string }> {
  const { res, finalUrl } = await openStream(url, opts);
  return { res, status: res.statusCode ?? 0, finalUrl };
}

/** Max bytes we'll buffer for an HTML page (guards against pathological responses). */
const MAX_TEXT_BYTES = 16 * 1024 * 1024;

/** Fetch a URL as text. Caps size, decompresses, throws on non-2xx. */
export async function httpText(
  url: string,
  opts: RequestOptions = {},
): Promise<{ status: number; body: string; finalUrl: string; setCookie: string[] }> {
  const { res, finalUrl } = await openStream(url, opts);
  const status = res.statusCode ?? 0;
  const rawCookies = res.headers['set-cookie'];
  const setCookie = Array.isArray(rawCookies) ? rawCookies : rawCookies ? [rawCookies] : [];
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    size += (chunk as Buffer).length;
    if (size > MAX_TEXT_BYTES) {
      res.destroy();
      throw new Error(`Response too large (>${MAX_TEXT_BYTES} bytes) for ${finalUrl}`);
    }
    chunks.push(chunk as Buffer);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status} for ${finalUrl}`);
  }

  // We request identity, but decompress defensively in case the CDN ignores it.
  let buf = Buffer.concat(chunks);
  const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
  try {
    if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf);
    else if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
    else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
  } catch {
    /* leave as-is; parser will simply find nothing */
  }
  return { status, body: buf.toString('utf8'), finalUrl, setCookie };
}

export type ProgressCb = (downloaded: number, total: number | undefined) => void;

/**
 * Stream a URL to `dest` (written to `dest + ".part"` then renamed on success).
 * Returns the total bytes written. Throws on non-2xx.
 */
export async function downloadToFile(
  url: string,
  dest: string,
  opts: RequestOptions & { onProgress?: ProgressCb } = {},
): Promise<number> {
  const { onProgress, ...reqOpts } = opts;
  const { res, finalUrl } = await openStream(url, reqOpts);
  const status = res.statusCode ?? 0;
  if (status < 200 || status >= 300) {
    res.resume();
    throw new Error(`HTTP ${status} for ${finalUrl}`);
  }
  // Akamai/WAF soft-blocks return 200 with an HTML "Access Denied" body —
  // never a real media file. Reject so the caller retries another IP/mirror.
  const ctype = String(res.headers['content-type'] ?? '').toLowerCase();
  if (ctype.startsWith('text/html') || ctype.startsWith('text/plain')) {
    res.resume();
    throw new Error(`blocked (got ${ctype || 'non-media'} response)`);
  }

  const totalHeader = res.headers['content-length'];
  const total = totalHeader ? Number(totalHeader) : undefined;
  let downloaded = 0;

  // Count bytes inside the pipeline (a pass-through Transform) so there is no
  // flowing-mode race between the progress listener and the file writer.
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      downloaded += chunk.length;
      onProgress?.(downloaded, total);
      cb(null, chunk);
    },
  });

  const part = `${dest}.part`;
  try {
    await pipeline(res, counter, createWriteStream(part));
    if (total !== undefined && downloaded !== total) {
      throw new Error(`Truncated download: got ${downloaded} of ${total} bytes`);
    }
    await rename(part, dest);
    return downloaded;
  } catch (err) {
    await unlink(part).catch(() => {});
    throw err;
  }
}
