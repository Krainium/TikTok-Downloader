/**
 * Download orchestration — fully native (node:https streaming), no yt-dlp.
 *
 * Video, images and audio are all streamed the same way: try each CDN mirror
 * URL, each over the direct IP then the proxy, rendering a live progress bar.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { runtime, WEB_UA, redact, proxyConfigured } from './config.js';
import { downloadToFile } from './http.js';
import { ProgressBar } from './progress.js';
import { rankFormats } from './extractor.js';
import { makeBase, uniquePath, resolutionLabel, guessImageExt } from './util.js';
import * as c from './colors.js';
import type { VideoPost, ImagePost, TikTokPost, VideoFormat, ProxyMode } from './types.js';

const errMsg = (e: unknown): string => redact(e instanceof Error ? e.message : String(e));

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Proxy attempt order, biased to what extraction used. The proxy is rotating,
 * so repeated `true` entries are fresh-IP retries (helps past a flaky exit/Akamai).
 */
function downloadOrder(mode: ProxyMode, usedProxy: boolean): boolean[] {
  const base =
    mode === 'direct'
      ? [false]
      : mode === 'proxy'
        ? [true, true, true]
        : usedProxy
          ? [true, true, false]
          : [false, true, true];
  // Drop proxy attempts when no proxy is configured; never end up with nothing.
  const order = base.filter((useProxy) => !useProxy || proxyConfigured());
  return order.length ? order : [false];
}

const REFERER = 'https://www.tiktok.com/';

/**
 * Download one logical file, trying each mirror URL and each transport until
 * one succeeds. Renders a progress bar per attempt.
 */
async function streamWithFallback(
  urls: string[],
  outPath: string,
  order: boolean[],
  barLabel: string,
  cookie?: string,
): Promise<void> {
  rmSync(`${outPath}.part`, { force: true });
  const candidates = urls.filter(Boolean);
  if (!candidates.length) throw new Error('no download URL available');

  const headers: Record<string, string> = { 'User-Agent': WEB_UA, Referer: REFERER, Accept: '*/*' };
  if (cookie) headers.Cookie = cookie;

  let lastErr: unknown;
  let attempt = 0;
  for (const url of candidates) {
    for (const useProxy of order) {
      attempt++;
      if (attempt > 1) c.log.warn(`Retrying via ${useProxy ? 'proxy' : 'direct'}…`);
      const bar = new ProgressBar(barLabel + (useProxy ? c.dim(' (proxy)') : ''));
      try {
        const bytes = await downloadToFile(url, outPath, {
          proxy: useProxy,
          headers,
          onProgress: (d, t) => bar.update(d, t),
        });
        bar.finish(bytes, 'saved');
        return;
      } catch (e) {
        bar.abort();
        lastErr = e;
      }
    }
  }
  throw new Error(errMsg(lastErr));
}

/** Download the chosen video format. Returns the saved path(s). */
export async function downloadVideo(
  post: VideoPost,
  opts: { mode: ProxyMode; formatId?: string },
): Promise<string[]> {
  ensureDir(runtime.downloadDir);
  const ranked = rankFormats(post.formats);
  const chosen: VideoFormat =
    (opts.formatId && post.formats.find((f) => f.formatId === opts.formatId)) || ranked[0]!;

  const base = makeBase([post.uploader, post.title, post.id]);
  const outPath = uniquePath(existsSync, runtime.downloadDir, base, chosen.ext || 'mp4');

  c.log.step(
    `Downloading video  ${c.dim(
      `[${chosen.formatId}` +
        (resolutionLabel(chosen) ? ` ${resolutionLabel(chosen)}` : '') +
        (chosen.vcodec ? ` ${chosen.vcodec}` : '') +
        (chosen.watermarked ? ' watermarked' : '') +
        ']',
    )}`,
  );

  const order = downloadOrder(opts.mode, post.usedProxy);
  await streamWithFallback(
    chosen.urls,
    outPath,
    order,
    `  ${c.ttPink('▼')} ${path.basename(outPath)}`,
    post.cookie,
  );
  return [outPath];
}

/** Download every image (and optional audio) of a slideshow post. */
export async function downloadImages(
  post: ImagePost,
  opts: { mode: ProxyMode; withAudio?: boolean },
): Promise<string[]> {
  ensureDir(runtime.downloadDir);
  if (post.images.length === 0) throw new Error('This post contains no images.');

  const base = makeBase([post.uploader, post.title, post.id]);
  const order = downloadOrder(opts.mode, post.usedProxy);
  const saved: string[] = [];
  const pad = String(post.images.length).length;

  c.log.step(`Downloading ${c.bold(String(post.images.length))} image(s)`);
  for (let i = 0; i < post.images.length; i++) {
    const img = post.images[i]!;
    const n = String(i + 1).padStart(pad, '0');
    const ext = guessImageExt(img.url);
    const outPath = uniquePath(existsSync, runtime.downloadDir, `${base}_${n}`, ext);
    await streamWithFallback(
      img.urls,
      outPath,
      order,
      `  ${c.ttPink('▼')} image ${c.bold(`${i + 1}/${post.images.length}`)} ${c.dim(path.basename(outPath))}`,
    );
    saved.push(outPath);
  }

  if (opts.withAudio && post.audio) {
    const outPath = uniquePath(existsSync, runtime.downloadDir, `${base}_audio`, post.audio.ext);
    try {
      await streamWithFallback(
        post.audio.urls,
        outPath,
        order,
        `  ${c.ttPink('♪')} audio ${c.dim(path.basename(outPath))}`,
      );
      saved.push(outPath);
    } catch (e) {
      c.log.warn(`Could not download audio track (${errMsg(e)}). Skipping.`);
    }
  }

  return saved;
}

/** Dispatch by post kind. */
export async function downloadPost(
  post: TikTokPost,
  opts: { mode: ProxyMode; formatId?: string; withAudio?: boolean },
): Promise<string[]> {
  return post.kind === 'video' ? downloadVideo(post, opts) : downloadImages(post, opts);
}
