/** Shared domain types for extraction & download. */

export type ProxyMode = 'auto' | 'direct' | 'proxy';

export interface VideoFormat {
  formatId: string;
  ext: string;
  url: string;
  /** Mirror URLs to try in order (CDN gives several); `url` is urls[0]. */
  urls: string[];
  vcodec?: string;
  acodec?: string;
  width?: number;
  height?: number;
  tbr?: number; // total bitrate (kbps)
  filesize?: number; // bytes (exact or approx)
  note?: string;
  watermarked: boolean;
}

export interface ImageItem {
  url: string;
  urls: string[];
  width?: number;
  height?: number;
}

/** Optional background audio track of a slideshow / photo post. */
export interface AudioTrack {
  url: string;
  urls: string[];
  ext: string;
  formatId: string;
}

interface BasePost {
  id: string;
  title: string;
  uploader?: string;
  webpageUrl: string;
  thumbnail?: string;
  /** Whether extraction ended up going through the proxy. */
  usedProxy: boolean;
  /** Cookies captured during extraction, sent on download requests. */
  cookie?: string;
}

export interface VideoPost extends BasePost {
  kind: 'video';
  durationSec?: number;
  formats: VideoFormat[];
}

export interface ImagePost extends BasePost {
  kind: 'image';
  images: ImageItem[];
  audio?: AudioTrack;
}

export type TikTokPost = VideoPost | ImagePost;
