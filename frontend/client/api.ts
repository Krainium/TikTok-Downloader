/// <reference types="vite/client" />
/** Typed wrappers around the backend API + the SSE job stream. */
import type { ConfigInfo, ExploreItem, JobEvent, PostInfo, ProxyMode } from './types';

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  getConfig: () => request<ConfigInfo>('/api/config'),

  explore: () => request<{ items: ExploreItem[] }>('/api/explore'),

  setProxy: (proxy: string) =>
    request<{ ok: boolean; proxyConfigured: boolean }>('/api/proxy', {
      method: 'POST',
      body: JSON.stringify({ proxy }),
    }),

  extract: (url: string, mode: ProxyMode) =>
    request<PostInfo>('/api/extract', { method: 'POST', body: JSON.stringify({ url, mode }) }),

  startDownload: (opts: {
    url: string;
    mode: ProxyMode;
    want?: 'video' | 'image' | 'auto';
    formatId?: string;
    withAudio?: boolean;
  }) => request<{ jobId: string }>('/api/download', { method: 'POST', body: JSON.stringify(opts) }),
};

/**
 * Subscribe to a download job's progress. Returns an unsubscribe function.
 * The stream is closed automatically on a terminal `done`/`error` event.
 */
export function streamJob(jobId: string, onEvent: (e: JobEvent) => void): () => void {
  const es = new EventSource(`${API_BASE}/api/events/${jobId}`);
  es.onmessage = (msg) => {
    let parsed: JobEvent;
    try {
      parsed = JSON.parse(msg.data) as JobEvent;
    } catch {
      return;
    }
    onEvent(parsed);
    if (parsed.type === 'done' || parsed.type === 'error') es.close();
  };
  es.onerror = () => {
    // The server ends the stream after a terminal event; ignore the resulting
    // error once we're already closing. Otherwise surface a connection drop.
    if (es.readyState === EventSource.CLOSED) return;
  };
  return () => es.close();
}
