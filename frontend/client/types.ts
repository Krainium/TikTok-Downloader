/** Client-side mirror of the server's API response shapes. */

export type ProxyMode = 'auto' | 'direct' | 'proxy';
export type FileType = 'video' | 'image' | 'audio';

export interface VideoFormatInfo {
  formatId: string;
  ext: string;
  resolution: string;
  vcodec: string | null;
  tbr: number | null;
  filesize: number | null;
  watermarked: boolean;
}

export interface ImageInfo {
  thumb: string;
  width: number | null;
  height: number | null;
}

export interface PostInfo {
  kind: 'video' | 'image';
  id: string;
  title: string;
  uploader: string | null;
  usedProxy: boolean;
  thumbnail: string | null;
  webpageUrl: string;
  durationSec?: number | null;
  formats?: VideoFormatInfo[];
  imageCount?: number;
  images?: ImageInfo[];
  hasAudio?: boolean;
}

export interface SavedFileInfo {
  index: number;
  name: string;
  size: number;
  type: FileType;
  url: string;
}

export interface ConfigInfo {
  proxyConfigured: boolean;
  proxy: string;
}

export interface ExploreItem {
  url: string;
  title: string;
  author: string;
  thumb: string | null;
}

/** Server-Sent Events emitted while a download job runs. */
export type JobEvent =
  | { type: 'status'; message: string }
  | { type: 'meta'; kind: 'video' | 'image'; title: string; uploader: string | null; usedProxy: boolean }
  | { type: 'file-start'; index: number; name: string; label: string }
  | {
      type: 'progress';
      index: number;
      name: string;
      downloaded: number;
      total: number | null;
      pct: number;
      speed: number;
      useProxy: boolean;
    }
  | { type: 'file-done'; index: number; name: string; size: number; fileType: FileType; url: string }
  | { type: 'done'; files: SavedFileInfo[] }
  | { type: 'error'; message: string };
