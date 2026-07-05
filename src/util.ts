/** Small formatting & filesystem helpers. */
import path from 'node:path';

/** 1536 -> "1.5 KB". */
export function humanBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** bytes/sec -> "1.5 MB/s". */
export function humanSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '—';
  return `${humanBytes(bytesPerSec)}/s`;
}

/** seconds -> "mm:ss" (or "h:mm:ss"). */
export function humanDuration(totalSec: number | undefined): string {
  if (totalSec === undefined || !Number.isFinite(totalSec) || totalSec < 0) return '—';
  const s = Math.floor(totalSec % 60);
  const m = Math.floor((totalSec / 60) % 60);
  const h = Math.floor(totalSec / 3600);
  const pad = (x: number) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'avif'];

/** Pick an image extension from a URL's path (ignoring the query string). */
export function guessImageExt(url: string, fallback = 'jpg'): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const m = pathname.match(/\.([a-z0-9]+)$/);
    const ext = m?.[1];
    if (ext && IMAGE_EXTS.includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  } catch {
    /* not a parseable URL */
  }
  return fallback;
}

/** "1080x1920", or "1920p", or "" — handles TikTok's portrait videos. */
export function resolutionLabel(f: { width?: number; height?: number }): string {
  if (f.width && f.height) return `${f.width}x${f.height}`;
  if (f.height) return `${f.height}p`;
  if (f.width) return `${f.width}w`;
  return '';
}

const ILLEGAL_FS = '/\\?%*:|"<>';

/**
 * Turn a string into a filename-safe slug: strips control chars,
 * filesystem-illegal chars and non-ASCII (emoji), collapses whitespace to "_".
 * Returns "" when nothing usable remains.
 */
export function slug(name: string, max = 60): string {
  let out = '';
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue; // control characters
    if (code > 0x7e) continue; // non-ASCII (emoji, etc.)
    if (ILLEGAL_FS.includes(ch)) continue; // illegal on common filesystems
    out += ch;
  }
  out = out.replace(/\s+/g, '_').replace(/_+/g, '_');
  out = out.slice(0, max).replace(/^[._]+|[._]+$/g, '');
  return out;
}

/** Single-component filename (with a fallback). */
export function sanitizeFilename(name: string, max = 60): string {
  return slug(name, max) || 'tiktok';
}

/** Join post fields into a clean base filename, dropping empty parts. */
export function makeBase(parts: Array<string | undefined>, maxEach = 40): string {
  const cleaned = parts
    .map((p) => slug(String(p ?? ''), maxEach))
    .filter((p) => p.length > 0);
  return cleaned.join('_') || 'tiktok';
}

/** Build "<dir>/<base>.<ext>", avoiding collisions with a counter. */
export function uniquePath(
  exists: (p: string) => boolean,
  dir: string,
  base: string,
  ext: string,
): string {
  let candidate = path.join(dir, `${base}.${ext}`);
  let n = 1;
  while (exists(candidate)) {
    candidate = path.join(dir, `${base} (${n}).${ext}`);
    n++;
  }
  return candidate;
}
