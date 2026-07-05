/**
 * Native TikTok mobile-API client — no yt-dlp, no binaries.
 *
 * Replicates the unauthenticated `aweme/v1/feed/` endpoint that the Android app
 * uses (no request signing required). One call returns everything we need:
 * video play URLs *and* `image_post_info` for photo/slideshow posts, on CDNs
 * that serve plain GETs (unlike the Akamai-protected webapp CDN).
 *
 * Request shape ported from yt-dlp's TikTok extractor.
 */
import { randomBytes, randomUUID, randomInt } from 'node:crypto';
import { httpText } from './http.js';
import type { VideoFormat, ImageItem, AudioTrack } from './types.js';

const API_HOST = 'api16-normal-c-useast1a.tiktokv.com';

interface AppInfo {
  app_name: string;
  app_version: string;
  manifest_app_version: string;
  aid: string;
}

/** A few known-good app identities; rotated if one gets rate-limited. */
const APP_INFO_POOL: AppInfo[] = [
  { app_name: 'musical_ly', app_version: '35.1.3', manifest_app_version: '2023501030', aid: '0' },
  { app_name: 'musical_ly', app_version: '34.1.2', manifest_app_version: '2023401020', aid: '0' },
  { app_name: 'trill', app_version: '34.1.2', manifest_app_version: '2023401020', aid: '1180' },
];

const hex = (n: number): string => randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);

function appUserAgent(a: AppInfo): string {
  const pkg =
    a.app_name === 'musical_ly'
      ? `com.zhiliaoapp.musically/${a.manifest_app_version}`
      : `com.ss.android.ugc.${a.app_name}/${a.manifest_app_version}`;
  return `${pkg} (Linux; U; Android 13; en_US; Pixel 7; Build/TD1A.220804.031; Cronet/58.0.2991.0)`;
}

function buildQuery(awemeId: string, a: AppInfo): string {
  const versionCode = a.app_version
    .split('.')
    .map((v) => String(Number(v)).padStart(2, '0'))
    .join('');
  const now = Date.now();
  const sec = Math.floor(now / 1000);
  const params: Record<string, string> = {
    aweme_id: awemeId,
    version_code: versionCode,
    version_name: a.app_version,
    manifest_version_code: a.manifest_app_version,
    update_version_code: a.manifest_app_version,
    ab_version: a.app_version,
    build_number: a.app_version,
    aid: a.aid,
    app_name: a.app_name,
    device_platform: 'android',
    os: 'android',
    ssmix: 'a',
    channel: 'googleplay',
    resolution: '1080*2400',
    dpi: '420',
    device_type: 'Pixel 7',
    device_brand: 'Google',
    language: 'en',
    os_api: '29',
    os_version: '13',
    ac: 'wifi',
    is_pad: '0',
    current_region: 'US',
    app_type: 'normal',
    sys_region: 'US',
    app_language: 'en',
    residence: 'US',
    timezone_name: 'America/New_York',
    timezone_offset: '-14400',
    host_abi: 'armeabi-v7a',
    locale: 'en',
    ac2: 'wifi5g',
    uoo: '1',
    carrier_region: 'US',
    op_region: 'US',
    region: 'US',
    _rticket: String(now),
    ts: String(sec),
    cdid: randomUUID(),
    last_install_time: String(sec - randomInt(86400, 1123200)),
    device_id: String(randomInt(7250000000000000, 7325099899999994)) + String(randomInt(100, 999)),
    openudid: hex(16),
  };
  return new URLSearchParams(params).toString();
}

export interface ParsedAweme {
  id: string;
  title: string;
  uploader?: string;
  thumbnail?: string;
  durationSec?: number;
  videoFormats: VideoFormat[];
  images: ImageItem[];
  audio?: AudioTrack;
}

const urlList = (o: unknown): string[] => {
  const list = (o as { url_list?: unknown })?.url_list;
  return Array.isArray(list) ? list.filter((u): u is string => typeof u === 'string') : [];
};
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Normalise an aweme detail object into our domain shape. */
export function parseAwemeDetail(aweme: Record<string, any>): ParsedAweme {
  const video = aweme.video ?? {};
  const imagePost = aweme.image_post_info ?? {};

  // ---- video formats (from bit_rate gears + the watermarked download_addr) ----
  const videoFormats: VideoFormat[] = [];
  for (const b of (video.bit_rate ?? []) as any[]) {
    const urls = urlList(b.play_addr);
    if (!urls.length) continue;
    const isH265 = Boolean(b.is_bytevc1 ?? b.is_h265);
    videoFormats.push({
      formatId: String(b.gear_name ?? `gear_${videoFormats.length}`),
      ext: 'mp4',
      url: urls[0]!,
      urls,
      vcodec: isH265 ? 'h265' : 'h264',
      acodec: 'aac',
      width: num(b.play_addr?.width),
      height: num(b.play_addr?.height),
      tbr: num(b.bit_rate) ? Math.round((b.bit_rate as number) / 1000) : undefined,
      filesize: num(b.play_addr?.data_size),
      watermarked: false,
    });
  }
  const dl = urlList(video.download_addr);
  if (dl.length) {
    videoFormats.push({
      formatId: 'download',
      ext: 'mp4',
      url: dl[0]!,
      urls: dl,
      vcodec: 'h264',
      acodec: 'aac',
      width: num(video.download_addr?.width),
      height: num(video.download_addr?.height),
      filesize: num(video.download_addr?.data_size),
      note: 'watermarked',
      watermarked: true,
    });
  }

  // ---- images (display_image = full-res, no watermark) ----
  const images: ImageItem[] = [];
  for (const im of (imagePost.images ?? []) as any[]) {
    const urls = urlList(im.display_image) || [];
    if (!urls.length) continue;
    images.push({
      url: urls[0]!,
      urls,
      width: num(im.display_image?.width),
      height: num(im.display_image?.height),
    });
  }

  // ---- audio track ----
  let audio: AudioTrack | undefined;
  const musicUrls = urlList(aweme.music?.play_url);
  if (musicUrls.length) {
    const ext = /\.mp3(\?|$)/i.test(musicUrls[0]!) ? 'mp3' : 'm4a';
    audio = { url: musicUrls[0]!, urls: musicUrls, ext, formatId: 'music' };
  }

  const cover = urlList(video.cover)[0] ?? urlList(video.origin_cover)[0] ?? images[0]?.url;
  return {
    id: String(aweme.aweme_id ?? ''),
    title: String(aweme.desc ?? '').trim() || `tiktok_${aweme.aweme_id ?? ''}`,
    uploader: aweme.author?.unique_id ? String(aweme.author.unique_id) : undefined,
    thumbnail: cover,
    durationSec: num(video.duration) ? Math.round((video.duration as number) / 1000) : num(aweme.music?.duration),
    videoFormats,
    images,
    audio,
  };
}

/**
 * Fetch + parse an aweme via the mobile API. Rotates app identities on
 * rate-limit. Throws if all identities fail.
 */
export async function fetchAweme(awemeId: string, useProxy: boolean): Promise<ParsedAweme> {
  let lastErr = 'unknown error';
  for (const app of APP_INFO_POOL) {
    const url = `https://${API_HOST}/aweme/v1/feed/?${buildQuery(awemeId, app)}`;
    try {
      const { body } = await httpText(url, {
        proxy: useProxy,
        headers: {
          'User-Agent': appUserAgent(app),
          Accept: 'application/json',
          Cookie: `odin_tt=${hex(160)}`,
        },
      });
      const trimmed = body.trimStart();
      if (!trimmed.startsWith('{')) {
        lastErr = trimmed.slice(0, 60).replace(/\s+/g, ' ') || 'empty response';
        continue; // e.g. "ratelimit triggered" — rotate app identity
      }
      const data = JSON.parse(trimmed);
      const aweme = data.aweme_list?.[0] ?? data.aweme_detail;
      if (aweme?.aweme_id) return parseAwemeDetail(aweme);
      lastErr = `status_code ${data.status_code ?? '?'}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`mobile API unavailable (${lastErr})`);
}
