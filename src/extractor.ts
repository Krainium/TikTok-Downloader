/**
 * Extraction layer — fully native, no external binaries.
 *
 *  1. Mobile API (`api.ts`) — preferred. One call yields video play URLs and
 *     `image_post_info`, on plain-GET CDNs.
 *  2. Webpage `__UNIVERSAL_DATA_FOR_REHYDRATION__` / `SIGI_STATE` — fallback
 *     when the API is rate-limited (great for images via the proxy).
 *
 * Both routes try the datacenter IP first and fall back to the residential proxy.
 */
import { fetchAweme } from './api.js';
import { httpText, resolveFinalUrl } from './http.js';
import { WEB_UA, redact, proxyConfigured } from './config.js';
import * as c from './colors.js';
import type {
  TikTokPost,
  VideoPost,
  ImagePost,
  VideoFormat,
  ProxyMode,
  ImageItem,
  AudioTrack,
} from './types.js';

function proxyOrder(mode: ProxyMode): boolean[] {
  const base = mode === 'direct' ? [false] : mode === 'proxy' ? [true] : [false, true];
  // Drop proxy attempts when no proxy is configured; never end up with nothing.
  const order = base.filter((useProxy) => !useProxy || proxyConfigured());
  return order.length ? order : [false];
}

const errMsg = (e: unknown): string => redact(e instanceof Error ? e.message : String(e));
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Highest-resolution playable, non-watermarked format first. */
export function rankFormats(formats: VideoFormat[]): VideoFormat[] {
  return [...formats].sort((a, b) => {
    if (a.watermarked !== b.watermarked) return a.watermarked ? 1 : -1;
    const ah = a.height ?? 0;
    const bh = b.height ?? 0;
    if (ah !== bh) return bh - ah;
    return (b.tbr ?? 0) - (a.tbr ?? 0);
  });
}

/** Pull the numeric post id straight from a /video/ or /photo/ URL. */
export function parseAwemeId(url: string): string | null {
  return (
    url.match(/\/(?:video|photo|v)\/(\d+)/)?.[1] ??
    url.match(/\b(\d{10,25})\b/)?.[1] ??
    null
  );
}

/** Resolve id + canonical URL, following short links (vm/vt.tiktok.com). */
async function resolveId(url: string, order: boolean[]): Promise<{ id: string; canonicalUrl: string }> {
  const direct = parseAwemeId(url);
  if (direct) return { id: direct, canonicalUrl: url };

  for (const useProxy of order) {
    try {
      const finalUrl = await resolveFinalUrl(url, {
        proxy: useProxy,
        headers: { 'User-Agent': WEB_UA },
      });
      const id = parseAwemeId(finalUrl);
      if (id) return { id, canonicalUrl: finalUrl };
    } catch {
      /* try next transport */
    }
  }
  throw new Error('Could not determine the TikTok post id from that URL.');
}

// --- webpage fallback -------------------------------------------------------

function extractScriptJson(html: string, id: string): Record<string, any> | null {
  const m = html.match(new RegExp(`<script id="${id}"[^>]*>([\\s\\S]*?)</script>`));
  if (!m?.[1]) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

interface UniversalItem {
  item?: Record<string, any>;
  statusCode?: number;
  statusMsg?: string;
}

function getItemStruct(html: string): UniversalItem {
  const universal = extractScriptJson(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__');
  const scope = (universal?.['__DEFAULT_SCOPE__'] ?? {}) as Record<string, any>;
  const detail = scope['webapp.video-detail'] as Record<string, any> | undefined;
  let item = detail?.itemInfo?.itemStruct as Record<string, any> | undefined;
  if (!item || Object.keys(item).length === 0) {
    const sigi = extractScriptJson(html, 'SIGI_STATE');
    const mod = (sigi?.['ItemModule'] ?? {}) as Record<string, any>;
    const first = Object.keys(mod)[0];
    if (first) item = mod[first];
  }
  return { item, statusCode: detail?.statusCode as number | undefined, statusMsg: detail?.statusMsg as string | undefined };
}

export interface ImageScrape {
  images: ImageItem[];
  audio?: AudioTrack;
  statusCode?: number;
  statusMsg?: string;
}

/** Image-post parser (kept stand-alone for tests). */
export function parseImageWebpage(html: string): ImageScrape {
  const { item, statusCode, statusMsg } = getItemStruct(html);
  const images: ImageItem[] = [];
  for (const im of (item?.imagePost?.images ?? []) as any[]) {
    const list = (im?.imageURL?.urlList ?? im?.imageUrl?.urlList ?? []) as string[];
    if (list[0]) images.push({ url: list[0], urls: list, width: num(im?.imageWidth), height: num(im?.imageHeight) });
  }
  let audio: AudioTrack | undefined;
  const playUrl = str(item?.music?.playUrl);
  if (playUrl) {
    audio = { url: playUrl, urls: [playUrl], ext: /\.mp3(\?|$)/i.test(playUrl) ? 'mp3' : 'm4a', formatId: 'music' };
  }
  return { images, audio, statusCode, statusMsg };
}

async function extractFromWebpage(
  fetchUrl: string,
  displayUrl: string,
  useProxy: boolean,
): Promise<TikTokPost> {
  // With a rotating proxy each retry gets a fresh IP — useful when an IP lands
  // on the captcha/WAF shell instead of the server-rendered data.
  const maxTries = useProxy ? 4 : 1;
  let lastStatus: { statusCode?: number; statusMsg?: string } = {};
  let item: Record<string, any> | undefined;
  let cookie: string | undefined;

  for (let t = 0; t < maxTries; t++) {
    const { body, setCookie } = await httpText(fetchUrl, {
      proxy: useProxy,
      headers: {
        'User-Agent': WEB_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const got = getItemStruct(body);
    lastStatus = { statusCode: got.statusCode, statusMsg: got.statusMsg };
    if (got.item && Object.keys(got.item).length > 0) {
      item = got.item;
      cookie = setCookie.map((c) => c.split(';')[0]).filter(Boolean).join('; ') || undefined;
      break;
    }
  }

  if (!item) {
    if (lastStatus.statusCode) {
      throw new Error(
        `TikTok status ${lastStatus.statusCode}${lastStatus.statusMsg ? ` (${lastStatus.statusMsg})` : ''} — the post may be private, region-locked or removed.`,
      );
    }
    throw new Error('Could not read post data (TikTok bot challenge). Try again or use --proxy.');
  }
  const url = displayUrl;

  const base = {
    id: String(item.id ?? ''),
    title: str(item.desc) ?? `tiktok_${item.id ?? ''}`,
    uploader: str(item.author?.uniqueId) ?? str(item.author?.unique_id),
    webpageUrl: url,
    thumbnail: str(item.video?.cover) ?? str(item.video?.originCover),
    usedProxy: useProxy,
    cookie,
  };

  // Image post?
  const rawImages = (item.imagePost?.images ?? []) as any[];
  if (rawImages.length) {
    const images: ImageItem[] = [];
    for (const im of rawImages) {
      const list = (im?.imageURL?.urlList ?? im?.imageUrl?.urlList ?? []) as string[];
      if (list[0]) images.push({ url: list[0], urls: list, width: num(im?.imageWidth), height: num(im?.imageHeight) });
    }
    if (!images.length) throw new Error('Image post contained no images.');
    const playUrl = str(item.music?.playUrl);
    const audio: AudioTrack | undefined = playUrl
      ? { url: playUrl, urls: [playUrl], ext: /\.mp3(\?|$)/i.test(playUrl) ? 'mp3' : 'm4a', formatId: 'music' }
      : undefined;
    const post: ImagePost = { kind: 'image', ...base, images, audio };
    return post;
  }

  // Video post (note: webapp CDN URLs may be bot-protected; API is preferred).
  const v = (item.video ?? {}) as Record<string, any>;
  const formats: VideoFormat[] = [];
  for (const b of (v.bitrateInfo ?? []) as any[]) {
    const list = (b?.PlayAddr?.UrlList ?? []) as string[];
    if (!list.length) continue;
    const codec = String(b.CodecType ?? '');
    formats.push({
      formatId: String(b.GearName ?? `gear_${formats.length}`),
      ext: 'mp4',
      url: list[0]!,
      urls: list,
      vcodec: /h265|hvc|bytevc1/i.test(codec) ? 'h265' : 'h264',
      acodec: 'aac',
      width: num(b.PlayAddr?.Width),
      height: num(b.PlayAddr?.Height),
      filesize: num(b.PlayAddr?.DataSize),
      tbr: num(b.Bitrate) ? Math.round((b.Bitrate as number) / 1000) : undefined,
      watermarked: false,
    });
  }
  const dl = str(v.downloadAddr) ?? str(v.playAddr);
  if (!formats.length && dl) {
    formats.push({ formatId: 'download', ext: 'mp4', url: dl, urls: [dl], vcodec: 'h264', watermarked: true });
  }
  if (!formats.length) throw new Error('No downloadable media found on the webpage.');

  const post: VideoPost = { kind: 'video', ...base, durationSec: num(v.duration), formats: rankFormats(formats) };
  return post;
}

// --- public API -------------------------------------------------------------

/** Extract a post (video or image), webpage-first with mobile-API fallback. */
export async function extractPost(url: string, mode: ProxyMode): Promise<TikTokPost> {
  const order = proxyOrder(mode);
  const { id, canonicalUrl } = await resolveId(url, order);
  // TikTok server-renders post data on the /video/ endpoint, but shows a
  // captcha shell on /photo/ — so always fetch via /video/<id>.
  const user = canonicalUrl.match(/@([\w.\-]+)/)?.[1] ?? '_';
  const fetchUrl = `https://www.tiktok.com/@${user}/video/${id}`;
  let lastErr: unknown;

  // 1) Webpage SSR data (primary) — yields video formats AND imagePost images.
  for (const useProxy of order) {
    try {
      return await extractFromWebpage(fetchUrl, canonicalUrl, useProxy);
    } catch (e) {
      lastErr = e;
      if (!useProxy && order.length > 1) {
        c.log.warn(`Web extraction (direct) failed: ${errMsg(e)} — retrying via proxy…`);
      }
    }
  }

  // 2) Mobile API fallback (clean CDN URLs, but rate-limited more aggressively).
  c.log.warn(`Web extraction failed (${errMsg(lastErr)}). Trying mobile API…`);
  for (const useProxy of order) {
    try {
      const p = await fetchAweme(id, useProxy);
      const baseMeta = {
        id: p.id || id,
        title: p.title,
        uploader: p.uploader,
        webpageUrl: canonicalUrl,
        thumbnail: p.thumbnail,
        usedProxy: useProxy,
      };
      if (p.videoFormats.length) {
        return { kind: 'video', ...baseMeta, durationSec: p.durationSec, formats: rankFormats(p.videoFormats) };
      }
      if (p.images.length) {
        return { kind: 'image', ...baseMeta, images: p.images, audio: p.audio };
      }
      throw new Error('API returned no downloadable media');
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
