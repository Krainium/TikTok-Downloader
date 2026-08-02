/**
 * Shared job state.
 *
 * The web server keeps jobs in an in-memory Map, which is fine for a single
 * long-lived container. On a platform that runs several instances (Vercel), the
 * POST that starts a job and the SSE request that follows it can land on
 * different instances, so the second one sees "unknown job".
 *
 * When BLOB_READ_WRITE_TOKEN is present every job snapshot is mirrored to Vercel
 * Blob and saved files are uploaded there too, so any instance can serve the
 * progress stream and the finished files. Without the token this is inert and
 * the server behaves exactly as before.
 */
import { readFile } from 'node:fs/promises';

export interface StoredFile {
  index: number;
  name: string;
  size: number;
  type: 'video' | 'image' | 'audio';
  /** Blob URL when uploaded; absent for local-only jobs. */
  href?: string;
}

export interface JobSnapshot {
  id: string;
  log: string[];
  files: StoredFile[];
  finished: boolean;
  updatedAt: number;
}

export const sharedEnabled = (): boolean => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

const key = (id: string) => `jobs/${id}.json`;

// Loaded lazily so the import costs nothing when the token is unset.
type BlobApi = typeof import('@vercel/blob');
let blobMod: BlobApi | null = null;
async function blob(): Promise<BlobApi> {
  if (!blobMod) blobMod = await import('@vercel/blob');
  return blobMod;
}

/**
 * Progress frames arrive many times a second. Snapshots are coalesced so Blob
 * sees roughly one write per second, and `force` pushes immediately for events
 * a waiting client must not miss (file-done, done, error).
 */
const MIN_WRITE_INTERVAL_MS = 900;
const lastWrite = new Map<string, number>();
const pending = new Map<string, NodeJS.Timeout>();

export async function publish(snap: JobSnapshot, force = false): Promise<void> {
  if (!sharedEnabled()) return;

  const now = Date.now();
  const since = now - (lastWrite.get(snap.id) ?? 0);
  if (!force && since < MIN_WRITE_INTERVAL_MS) {
    if (pending.has(snap.id)) return; // a flush is already queued
    const t = setTimeout(() => {
      pending.delete(snap.id);
      void publish(snap, true);
    }, MIN_WRITE_INTERVAL_MS - since);
    t.unref();
    pending.set(snap.id, t);
    return;
  }

  const queued = pending.get(snap.id);
  if (queued) { clearTimeout(queued); pending.delete(snap.id); }
  lastWrite.set(snap.id, now);

  try {
    const { put } = await blob();
    await put(key(snap.id), JSON.stringify({ ...snap, updatedAt: now }), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
    });
  } catch {
    // A dropped snapshot only costs this poll cycle; the next write recovers.
  }
}

export async function fetchSnapshot(id: string): Promise<JobSnapshot | null> {
  if (!sharedEnabled()) return null;
  try {
    const { head } = await blob();
    const meta = await head(key(id));
    const r = await fetch(meta.url, { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json()) as JobSnapshot;
  } catch {
    return null; // not found yet, or Blob unreachable
  }
}

/**
 * Upload a finished file and return a URL the browser will save rather than
 * play. Blob serves `content-disposition: inline` from the plain `url`, which
 * makes a video open in the tab instead of downloading — `downloadUrl` is the
 * same object served as an attachment.
 *
 * The index goes in the path rather than the filename so the saved file keeps
 * its real name instead of picking up a `0-` prefix.
 */
export async function uploadFile(
  id: string,
  index: number,
  name: string,
  filePath: string,
): Promise<string | undefined> {
  if (!sharedEnabled()) return undefined;
  try {
    const { put } = await blob();
    const body = await readFile(filePath);
    const res = await put(`jobs/${id}/${index}/${name}`, body, {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return res.downloadUrl ?? res.url;
  } catch {
    return undefined; // fall back to serving from local disk
  }
}
