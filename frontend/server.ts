/**
 * Web frontend server for the TikTok downloader.
 *
 * A dependency-free node:http server (port 4444) that wraps the existing
 * extraction/download engine in `../src` and serves a single-page dark UI.
 *
 *   GET  /                      → the SPA (public/index.html)
 *   GET  /<asset>               → static files from public/
 *   GET  /api/config            → whether a proxy is configured (boolean only)
 *   POST /api/proxy             → set the residential proxy (host:port:user:pass)
 *   POST /api/extract           → metadata + formats/images for a URL (preview)
 *   POST /api/download          → start a server-side download job → { jobId }
 *   GET  /api/events/:jobId     → Server-Sent Events: live progress for a job
 *   GET  /api/file/:jobId/:i    → download saved file i (attachment)
 *   GET  /api/thumb?url=…       → proxy a TikTok CDN thumbnail to the browser
 */
import http from 'node:http';
import { readFile, mkdir, stat, rm } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractPost, rankFormats } from '../src/extractor.js';
import { publish, fetchSnapshot, uploadFile, sharedEnabled } from './jobstore.js';
import { downloadToFile, httpStream, httpText } from '../src/http.js';
import {
  setProxyFromString,
  proxyConfigured,
  WEB_UA,
  redact,
} from '../src/config.js';
import { makeBase, uniquePath, guessImageExt, resolutionLabel } from '../src/util.js';
import { fetchLiveTrending, closeBrowser } from './explore-live.js';
import type { ProxyMode, TikTokPost, VideoFormat } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, 'dist'); // vite build output (React bundle)
const CACHE_DIR = path.resolve(__dirname, '..', 'downloads', 'web');
const PORT = Number(process.env.PORT ?? 4444);
const HOST = process.env.HOST ?? '0.0.0.0';

const errMsg = (e: unknown): string => redact(e instanceof Error ? e.message : String(e));
const isMode = (m: unknown): m is ProxyMode => m === 'auto' || m === 'direct' || m === 'proxy';

/**
 * "Explore" feed. TikTok signs every trending/feed/list endpoint (X-Bogus /
 * msToken), so a fully automatic "For You" list isn't reachable unsigned — but
 * each item's preview is pulled **live** from TikTok's official oEmbed endpoint
 * (current thumbnail/title/author, dead links auto-dropped). The seed pool is
 * operator-configurable via TIKTOK_EXPLORE (comma-separated URLs) and shuffled
 * on each refresh, so it isn't a fixed hardcoded list.
 */
const EXPLORE_POOL: string[] = (
  process.env.TIKTOK_EXPLORE
    ? process.env.TIKTOK_EXPLORE.split(',')
    : [
        'https://www.tiktok.com/@melanin_dripping0/video/7652513683674909972',
        'https://www.tiktok.com/@justjessy900/video/7647104492755832085',
        'https://www.tiktok.com/@yawdabo_adwenkese3/video/7654742695398608135',
      ]
)
  .map((u) => u.trim())
  .filter(Boolean);

interface ExploreItem {
  url: string;
  title: string;
  author: string;
  thumb: string | null;
}

const EXPLORE_TTL = 10 * 60_000;
let exploreCache: { at: number; items: ExploreItem[] } | null = null;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Resolve a single TikTok URL to a live preview via the official oEmbed API. */
async function oembed(url: string): Promise<ExploreItem | null> {
  const endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  const order = proxyConfigured() ? [false, true] : [false];
  for (const proxy of order) {
    try {
      const { body } = await httpText(endpoint, {
        proxy,
        timeoutMs: 15_000,
        headers: { 'User-Agent': WEB_UA, Accept: 'application/json' },
      });
      const d = JSON.parse(body) as Record<string, unknown>;
      const id = typeof d.embed_product_id === 'string' ? d.embed_product_id : '';
      const authorUrl = typeof d.author_url === 'string' ? d.author_url : '';
      const canonical = authorUrl && id ? `${authorUrl}/video/${id}` : url;
      const thumb = typeof d.thumbnail_url === 'string' ? d.thumbnail_url : '';
      return {
        url: canonical,
        title: (typeof d.title === 'string' && d.title.trim()) || 'TikTok video',
        author: typeof d.author_unique_id === 'string' ? d.author_unique_id : '',
        thumb: thumb ? `/api/thumb?url=${encodeURIComponent(thumb)}` : null,
      };
    } catch {
      /* try next transport */
    }
  }
  return null;
}

/** oEmbed-resolve the seed pool (fallback when the live browser feed is unavailable). */
async function exploreFromPool(): Promise<ExploreItem[]> {
  const pick = shuffle(EXPLORE_POOL).slice(0, 10);
  return (await Promise.all(pick.map(oembed))).filter((x): x is ExploreItem => x !== null);
}

/**
 * Resolve the explore feed (cached ~10 min). Primary source is the live browser
 * feed (auto-rotating trending); falls back to the oEmbed seed pool. Coalesces
 * concurrent refreshes into one.
 */
let exploreInFlight: Promise<ExploreItem[]> | null = null;
async function getExplore(): Promise<ExploreItem[]> {
  if (exploreCache && Date.now() - exploreCache.at < EXPLORE_TTL) return exploreCache.items;
  if (exploreInFlight) return exploreInFlight;
  exploreInFlight = (async () => {
    let items: ExploreItem[] = [];
    if (process.env.EXPLORE_LIVE !== '0') {
      try {
        items = await fetchLiveTrending(12);
      } catch {
        /* browser unavailable — fall back below */
      }
    }
    if (!items.length) items = await exploreFromPool();
    if (items.length) exploreCache = { at: Date.now(), items };
    return items;
  })();
  try {
    return await exploreInFlight;
  } finally {
    exploreInFlight = null;
  }
}

// ── jobs ───────────────────────────────────────────────────────────────────

interface SavedFile {
  index: number;
  name: string;
  path: string;
  size: number;
  type: 'video' | 'image' | 'audio';
  /** Blob URL once uploaded; lets another instance serve the file. */
  href?: string;
}
interface Job {
  id: string;
  dir: string;
  clients: Set<http.ServerResponse>;
  log: string[]; // already-formatted SSE frames, replayed to late subscribers
  files: SavedFile[];
  finished: boolean;
}
const jobs = new Map<string, Job>();

/**
 * Stream a job this instance does not own. The owning instance mirrors its
 * frame log to shared storage; we poll it and forward whatever is new.
 */
const SHARED_POLL_MS = 1000;
const SHARED_MAX_WAIT_MS = 10 * 60_000;

async function streamSharedJob(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  jobId: string,
): Promise<void> {
  const first = await fetchSnapshot(jobId);
  if (!first) {
    sendJson(res, 404, { error: 'unknown job' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  let sent = 0;
  let open = true;
  req.on('close', () => { open = false; });

  const deadline = Date.now() + SHARED_MAX_WAIT_MS;
  let snap = first;
  for (;;) {
    for (; sent < snap.log.length; sent++) res.write(snap.log[sent]!);
    if (!open) return;
    if (snap.finished) break;
    if (Date.now() > deadline) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'timed out waiting for job' })}\n\n`);
      break;
    }
    await new Promise((r) => setTimeout(r, SHARED_POLL_MS));
    const next = await fetchSnapshot(jobId);
    if (next) snap = next;
  }
  res.end();
}

function emit(job: Job, type: string, data: Record<string, unknown> = {}): void {
  const frame = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  job.log.push(frame);
  for (const res of job.clients) res.write(frame);
  // Mirror to shared storage so an instance that did not start this job can
  // still stream it. Terminal events are flushed immediately.
  const terminal = type === 'done' || type === 'error' || type === 'file-done';
  void publish(
    {
      id: job.id,
      log: job.log,
      files: job.files.map((f) => ({
        index: f.index, name: f.name, size: f.size, type: f.type, href: f.href,
      })),
      finished: job.finished,
      updatedAt: Date.now(),
    },
    terminal,
  );
}

/** Proxy attempt order for a download, mirroring the CLI's biasing. */
function downloadOrder(mode: ProxyMode, usedProxy: boolean): boolean[] {
  const base =
    mode === 'direct'
      ? [false]
      : mode === 'proxy'
        ? [true, true, true]
        : usedProxy
          ? [true, true, false]
          : [false, true, true];
  const order = base.filter((p) => !p || proxyConfigured());
  return order.length ? order : [false];
}

const REFERER = 'https://www.tiktok.com/';

/** Stream one logical file, trying each mirror URL and transport until one works. */
async function streamLogicalFile(
  urls: string[],
  destPath: string,
  order: boolean[],
  cookie: string | undefined,
  onProgress: (downloaded: number, total: number | undefined, useProxy: boolean) => void,
): Promise<number> {
  const candidates = urls.filter(Boolean);
  if (!candidates.length) throw new Error('no download URL available');
  const headers: Record<string, string> = { 'User-Agent': WEB_UA, Referer: REFERER, Accept: '*/*' };
  if (cookie) headers.Cookie = cookie;

  let lastErr: unknown;
  for (const url of candidates) {
    for (const useProxy of order) {
      try {
        return await downloadToFile(url, destPath, {
          proxy: useProxy,
          headers,
          onProgress: (d, t) => onProgress(d, t, useProxy),
        });
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** A throttled progress emitter (≤ ~10 events/sec, but never skips a % change). */
function makeProgress(job: Job, index: number, name: string) {
  const start = Date.now();
  let lastAt = 0;
  let lastPct = -1;
  return (downloaded: number, total: number | undefined, useProxy: boolean) => {
    const now = Date.now();
    const pct = total && total > 0 ? Math.min(100, Math.floor((downloaded / total) * 100)) : -1;
    if (now - lastAt < 100 && pct === lastPct) return;
    lastAt = now;
    lastPct = pct;
    const elapsed = (now - start) / 1000;
    const speed = elapsed > 0 ? downloaded / elapsed : 0;
    emit(job, 'progress', { index, name, downloaded, total: total ?? null, pct, speed, useProxy });
  };
}

/** Run a download job to completion, emitting SSE events as it goes. */
async function runJob(
  job: Job,
  opts: { url: string; mode: ProxyMode; want: 'video' | 'image' | 'auto'; formatId?: string; withAudio: boolean },
): Promise<void> {
  emit(job, 'status', { message: 'Extracting post data…' });
  let post: TikTokPost;
  try {
    post = await extractPost(opts.url, opts.mode);
  } catch (e) {
    emit(job, 'error', { message: `Extraction failed: ${errMsg(e)}` });
    return;
  }

  await mkdir(job.dir, { recursive: true });
  const order = downloadOrder(opts.mode, post.usedProxy);
  const base = makeBase([post.uploader, post.title, post.id]);
  const exists = (p: string) => existsSync(p);

  emit(job, 'meta', {
    kind: post.kind,
    title: post.title,
    uploader: post.uploader ?? null,
    usedProxy: post.usedProxy,
  });

  try {
    if (post.kind === 'video') {
      const ranked = rankFormats(post.formats);
      const chosen: VideoFormat =
        (opts.formatId && post.formats.find((f) => f.formatId === opts.formatId)) || ranked[0]!;
      const outPath = uniquePath(exists, job.dir, base, chosen.ext || 'mp4');
      const name = path.basename(outPath);
      emit(job, 'file-start', { index: 0, name, label: 'video' });
      const size = await streamLogicalFile(
        chosen.urls,
        outPath,
        order,
        post.cookie,
        makeProgress(job, 0, name),
      );
      const videoHref = await uploadFile(job.id, 0, name, outPath);
      job.files.push({ index: 0, name, path: outPath, size, type: 'video', href: videoHref });
      emit(job, 'file-done', { index: 0, name, size, fileType: 'video', url: `/api/file/${job.id}/0` });
    } else {
      const pad = String(post.images.length).length;
      let index = 0;
      for (let i = 0; i < post.images.length; i++) {
        const img = post.images[i]!;
        const n = String(i + 1).padStart(pad, '0');
        const ext = guessImageExt(img.url);
        const outPath = uniquePath(exists, job.dir, `${base}_${n}`, ext);
        const name = path.basename(outPath);
        emit(job, 'file-start', { index, name, label: `image ${i + 1}/${post.images.length}` });
        const size = await streamLogicalFile(img.urls, outPath, order, post.cookie, makeProgress(job, index, name));
        const imageHref = await uploadFile(job.id, index, name, outPath);
        job.files.push({ index, name, path: outPath, size, type: 'image', href: imageHref });
        emit(job, 'file-done', { index, name, size, fileType: 'image', url: `/api/file/${job.id}/${index}` });
        index++;
      }
      if (opts.withAudio && post.audio) {
        const outPath = uniquePath(exists, job.dir, `${base}_audio`, post.audio.ext);
        const name = path.basename(outPath);
        emit(job, 'file-start', { index, name, label: 'audio' });
        try {
          const size = await streamLogicalFile(post.audio.urls, outPath, order, post.cookie, makeProgress(job, index, name));
          const audioHref = await uploadFile(job.id, index, name, outPath);
          job.files.push({ index, name, path: outPath, size, type: 'audio', href: audioHref });
          emit(job, 'file-done', { index, name, size, fileType: 'audio', url: `/api/file/${job.id}/${index}` });
        } catch (e) {
          emit(job, 'status', { message: `Audio track skipped (${errMsg(e)})` });
        }
        index++;
      }
    }
    emit(job, 'done', { files: job.files.map((f) => ({ index: f.index, name: f.name, size: f.size, type: f.type, url: `/api/file/${job.id}/${f.index}` })) });
  } catch (e) {
    emit(job, 'error', { message: `Download failed: ${errMsg(e)}` });
  } finally {
    job.finished = true;
    emit(job, 'finished');
    // Best-effort cleanup of disk + job state after 30 min.
    setTimeout(() => {
      jobs.delete(job.id);
      rm(job.dir, { recursive: true, force: true }).catch(() => {});
    }, 30 * 60_000).unref();
  }
}

// ── http helpers ─────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

function readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function parseJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    throw new Error('invalid JSON body');
  }
}

async function serveStatic(res: http.ServerResponse, urlPath: string): Promise<void> {
  if (!existsSync(DIST_DIR)) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' }).end(
      '<body style="font:16px system-ui;background:#08080c;color:#eee;padding:48px">' +
        '<h2>Web UI not built yet</h2><p>Run <code>npm run web:build</code> (or just <code>npm run web</code>) to build the React bundle, then reload.</p></body>',
    );
    return;
  }
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  // Prevent path traversal: resolve and confirm it stays inside DIST_DIR.
  let filePath = path.resolve(DIST_DIR, rel);
  if (filePath !== DIST_DIR && !filePath.startsWith(DIST_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  // SPA fallback: unknown, extension-less routes resolve to index.html.
  if (!existsSync(filePath) && !path.extname(filePath)) filePath = path.join(DIST_DIR, 'index.html');
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

// TikTok/ByteDance CDN host keywords. Thumbnails live on a sprawl of regional
// hosts (tiktokcdn.com, tiktokcdn-us.com, tiktokcdn-eu.com, p16-*.ibyteimg.com,
// …), so we allow any host containing one of these tokens — narrow enough to
// keep this from becoming an open image proxy (SSRF), broad enough to work.
const CDN_TOKENS = ['tiktok', 'byteimg', 'ibyteimg', 'muscdn', 'bytedance', 'ttwstatic', 'bytecdn', 'ibytedtos'];
const isTikTokCdnHost = (host: string): boolean => {
  const h = host.toLowerCase();
  return CDN_TOKENS.some((t) => h.includes(t));
};

/** Proxy a TikTok CDN image (thumbnail) to the browser, with direct→proxy fallback. */
async function serveThumb(res: http.ServerResponse, target: string): Promise<void> {
  let host: string;
  try {
    host = new URL(target).hostname;
  } catch {
    res.writeHead(400).end('bad url');
    return;
  }
  if (!isTikTokCdnHost(host)) {
    res.writeHead(403).end('host not allowed');
    return;
  }
  const order = proxyConfigured() ? [false, true] : [false];
  for (const useProxy of order) {
    try {
      const { res: upstream, status } = await httpStream(target, {
        proxy: useProxy,
        headers: { 'User-Agent': WEB_UA, Referer: REFERER, Accept: 'image/*,*/*' },
      });
      if (status < 200 || status >= 300) {
        upstream.resume();
        continue;
      }
      res.writeHead(200, {
        'Content-Type': String(upstream.headers['content-type'] ?? 'image/jpeg'),
        'Cache-Control': 'public, max-age=86400',
      });
      upstream.pipe(res);
      return;
    } catch {
      /* try next transport */
    }
  }
  res.writeHead(502, { 'Content-Type': 'text/plain' }).end('thumbnail unavailable');
}

// ── routing ──────────────────────────────────────────────────────────────────

function postToInfo(post: TikTokPost) {
  const baseMeta = {
    kind: post.kind,
    id: post.id,
    title: post.title,
    uploader: post.uploader ?? null,
    usedProxy: post.usedProxy,
    thumbnail: post.thumbnail ? `/api/thumb?url=${encodeURIComponent(post.thumbnail)}` : null,
    webpageUrl: post.webpageUrl,
  };
  if (post.kind === 'video') {
    return {
      ...baseMeta,
      durationSec: post.durationSec ?? null,
      formats: rankFormats(post.formats).map((f) => ({
        formatId: f.formatId,
        ext: f.ext,
        resolution: resolutionLabel(f),
        vcodec: f.vcodec ?? null,
        tbr: f.tbr ?? null,
        filesize: f.filesize ?? null,
        watermarked: f.watermarked,
      })),
    };
  }
  return {
    ...baseMeta,
    imageCount: post.images.length,
    images: post.images.map((im) => ({
      thumb: `/api/thumb?url=${encodeURIComponent(im.url)}`,
      width: im.width ?? null,
      height: im.height ?? null,
    })),
    hasAudio: Boolean(post.audio),
  };
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const { pathname } = url;
  const method = req.method ?? 'GET';

  if (pathname === '/api/config' && method === 'GET') {
    // Never expose proxy host/port/user to the browser — only whether one is set.
    return sendJson(res, 200, { proxyConfigured: proxyConfigured() });
  }

  if (pathname === '/api/explore' && method === 'GET') {
    return sendJson(res, 200, { items: await getExplore() });
  }

  if (pathname === '/api/proxy' && method === 'POST') {
    const body = await parseJsonBody(req);
    const input = typeof body.proxy === 'string' ? body.proxy : '';
    const err = setProxyFromString(input);
    if (err) return sendJson(res, 400, { ok: false, error: err });
    return sendJson(res, 200, { ok: true, proxyConfigured: proxyConfigured() });
  }

  if (pathname === '/api/extract' && method === 'POST') {
    const body = await parseJsonBody(req);
    const target = typeof body.url === 'string' ? body.url.trim() : '';
    const mode: ProxyMode = isMode(body.mode) ? body.mode : 'auto';
    if (!target) return sendJson(res, 400, { error: 'missing url' });
    try {
      const post = await extractPost(target, mode);
      return sendJson(res, 200, postToInfo(post));
    } catch (e) {
      return sendJson(res, 502, { error: errMsg(e) });
    }
  }

  if (pathname === '/api/download' && method === 'POST') {
    const body = await parseJsonBody(req);
    const target = typeof body.url === 'string' ? body.url.trim() : '';
    const mode: ProxyMode = isMode(body.mode) ? body.mode : 'auto';
    const want = body.want === 'video' || body.want === 'image' ? body.want : 'auto';
    const formatId = typeof body.formatId === 'string' ? body.formatId : undefined;
    const withAudio = body.withAudio === true;
    if (!target) return sendJson(res, 400, { error: 'missing url' });

    const id = randomUUID();
    const job: Job = { id, dir: path.join(CACHE_DIR, id), clients: new Set(), log: [], files: [], finished: false };
    jobs.set(id, job);
    // Fire and forget — progress is delivered over SSE.
    void runJob(job, { url: target, mode, want, formatId, withAudio });
    return sendJson(res, 202, { jobId: id });
  }

  const eventsMatch = pathname.match(/^\/api\/events\/([\w-]+)$/);
  if (eventsMatch && method === 'GET') {
    const jobId = eventsMatch[1]!;
    const job = jobs.get(jobId);
    // Not ours: another instance started it, so follow the shared snapshot.
    if (!job) return streamSharedJob(req, res, jobId);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    for (const frame of job.log) res.write(frame); // replay anything emitted before connect
    if (!job.finished) {
      job.clients.add(res);
      req.on('close', () => job.clients.delete(res));
    } else {
      res.end();
    }
    return;
  }

  const fileMatch = pathname.match(/^\/api\/file\/([\w-]+)\/(\d+)$/);
  if (fileMatch && method === 'GET') {
    const fileJobId = fileMatch[1]!;
    const fileIndex = Number(fileMatch[2]);
    const job = jobs.get(fileJobId);
    const file = job?.files.find((f) => f.index === fileIndex);

    if (!file || !existsSync(file.path)) {
      // Either a different instance holds the bytes, or this one was recycled.
      const snap = await fetchSnapshot(fileJobId);
      const remote = snap?.files.find((f) => f.index === fileIndex);
      if (remote?.href) {
        res.writeHead(302, { Location: remote.href });
        res.end();
        return;
      }
      return sendJson(res, 404, { error: 'file not found' });
    }
    const { size } = await stat(file.path);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': size,
      'Content-Disposition': `attachment; filename="${file.name.replace(/"/g, '')}"`,
    });
    createReadStream(file.path).pipe(res);
    return;
  }

  if (pathname === '/api/thumb' && method === 'GET') {
    const target = url.searchParams.get('url') ?? '';
    return serveThumb(res, target);
  }

  return sendJson(res, 404, { error: 'unknown endpoint' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      if (!res.headersSent) sendJson(res, 500, { error: errMsg(e) });
      else res.end();
    });
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    void serveStatic(res, url.pathname);
    return;
  }
  res.writeHead(405).end('Method not allowed');
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  // eslint-disable-next-line no-console
  console.log(`\n  TikTok Downloader web UI  →  http://${shown}:${PORT}\n  (serving ${DIST_DIR})\n`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void closeBrowser().finally(() => process.exit(0));
  });
}
