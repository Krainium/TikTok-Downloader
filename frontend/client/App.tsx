import { useCallback, useEffect, useRef, useState } from 'react';
import { api, streamJob } from './api';
import type { PostInfo, ProxyMode, SavedFileInfo } from './types';
import { Splash } from './components/Splash';
import { Storm } from './components/Storm';
import { SearchBar } from './components/SearchBar';
import { ResultCard } from './components/ResultCard';
import { ProgressCard, type ProgressState } from './components/ProgressCard';
import { FilesCard } from './components/FilesCard';
import { SettingsModal } from './components/SettingsModal';
import { ExploreModal } from './components/ExploreModal';
import { Toasts } from './components/Toasts';
import { useToasts } from './useToasts';

const TT_RE = /(?:^|\.)tiktok\.com\//i;
const loadMode = (): ProxyMode => {
  const m = localStorage.getItem('tt_mode');
  return m === 'direct' || m === 'proxy' || m === 'auto' ? m : 'auto';
};

export default function App() {
  const [splashHidden, setSplashHidden] = useState(false);
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<ProxyMode>(loadMode);
  const [loading, setLoading] = useState(false);
  const [post, setPost] = useState<PostInfo | null>(null);

  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [files, setFiles] = useState<SavedFileInfo[]>([]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [proxyConfigured, setProxyConfigured] = useState(false);

  const { toasts, push, dismiss } = useToasts();
  const unsubscribe = useRef<(() => void) | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Splash: fade out shortly after first paint.
  useEffect(() => {
    const t = window.setTimeout(() => setSplashHidden(true), 1900);
    return () => window.clearTimeout(t);
  }, []);

  // Load proxy config + clean up any live SSE on unmount.
  useEffect(() => {
    api
      .getConfig()
      .then((c) => setProxyConfigured(c.proxyConfigured))
      .catch(() => {});
    return () => unsubscribe.current?.();
  }, []);

  useEffect(() => localStorage.setItem('tt_mode', mode), [mode]);

  const changeMode = useCallback(
    (m: ProxyMode) => {
      setMode(m);
      if (m !== 'direct' && !proxyConfigured) {
        push('info', 'No proxy set — add yours in Settings (⚙) for the fallback.');
      }
    },
    [proxyConfigured, push],
  );

  const handleClear = useCallback(() => {
    unsubscribe.current?.(); // stop any in-flight progress stream
    setUrl('');
    setPost(null);
    setFiles([]);
    setProgress(null);
    setDownloading(false);
    setLoading(false);
  }, []);

  const handlePaste = useCallback(async () => {
    const mac = /Mac|iPhone|iPad/.test(navigator.userAgent);
    const key = mac ? '⌘V' : 'Ctrl+V';
    const focusField = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    // Reading the clipboard is only permitted in a secure context (https or
    // localhost) and isn't supported in Firefox web content. Use it where
    // allowed; otherwise focus the field and explain how to enable it.
    try {
      if (window.isSecureContext && navigator.clipboard?.readText) {
        const text = await navigator.clipboard.readText();
        if (text.trim()) {
          setUrl(text.trim());
          return;
        }
        push('info', 'Clipboard looks empty — copy a TikTok link first.');
        return;
      }
      throw new Error('clipboard read blocked');
    } catch {
      focusField();
      if (!window.isSecureContext) {
        const localUrl = `http://localhost:${window.location.port || '4444'}`;
        push('info', `Auto-paste needs a secure page. Open ${localUrl} (or serve over HTTPS) — for now press ${key}.`);
      } else {
        push('info', `Your browser blocks clipboard reads — press ${key} to paste here.`);
      }
    }
  }, [push]);

  const handleFetch = useCallback(async (explicit?: string) => {
    const target = (explicit ?? url).trim();
    if (explicit && explicit !== url) setUrl(explicit);
    if (!target) return push('err', 'Paste a TikTok link first.');
    if (!TT_RE.test(target)) push('info', "That doesn't look like a TikTok URL — trying anyway.");
    setLoading(true);
    setPost(null);
    setFiles([]);
    setProgress(null);
    try {
      const info = await api.extract(target, mode);
      setPost(info);
    } catch (e) {
      push('err', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [url, mode, push]);

  const handlePick = useCallback(
    (picked: string) => {
      setExploreOpen(false);
      void handleFetch(picked);
    },
    [handleFetch],
  );

  const handleDownload = useCallback(
    async (opts: { formatId?: string; withAudio: boolean }) => {
      if (!post) return;
      unsubscribe.current?.();
      setDownloading(true);
      setFiles([]);
      setProgress({ label: 'Preparing…', pct: -1, downloaded: 0, total: null, speed: 0, useProxy: false });

      try {
        const { jobId } = await api.startDownload({
          url: post.webpageUrl || url,
          mode,
          want: post.kind,
          formatId: opts.formatId,
          withAudio: opts.withAudio,
        });

        const received: SavedFileInfo[] = [];
        unsubscribe.current = streamJob(jobId, (e) => {
          switch (e.type) {
            case 'status':
              setProgress((p) => (p ? { ...p, label: e.message } : p));
              break;
            case 'file-start':
              setProgress({ label: e.label, pct: -1, downloaded: 0, total: null, speed: 0, useProxy: false });
              break;
            case 'progress':
              setProgress({
                label: e.name,
                pct: e.pct,
                downloaded: e.downloaded,
                total: e.total,
                speed: e.speed,
                useProxy: e.useProxy,
              });
              break;
            case 'file-done':
              received.push({ index: e.index, name: e.name, size: e.size, type: e.fileType, url: e.url });
              setFiles([...received]);
              break;
            case 'done':
              setFiles(e.files);
              setProgress(null);
              setDownloading(false);
              push('ok', `Done — ${e.files.length} file(s) ready to save.`);
              break;
            case 'error':
              setProgress(null);
              setDownloading(false);
              push('err', e.message);
              break;
          }
        });
      } catch (e) {
        setDownloading(false);
        setProgress(null);
        push('err', e instanceof Error ? e.message : String(e));
      }
    },
    [post, mode, url, push],
  );

  return (
    <>
      <Splash hide={splashHidden} />
      <Storm />

      <div className="app">
        <header className="topbar">
          <a className="brand" href="/">
            <span className="brand-mark">♪</span>
            <span className="brand-name">
              <b>TikTok</b> Downloader
            </span>
          </a>
          <nav className="top-actions">
            <button type="button" className="top-link" onClick={() => setExploreOpen(true)} title="Explore trending — get a link to test">
              ✨ Explore
            </button>
            <a
              className="top-link"
              href="https://github.com/Krainium/TikTok-Downloader"
              target="_blank"
              rel="noopener noreferrer"
              title="View source on GitHub"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.2.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.5 11.5 0 016 0C17 4.7 18 5 18 5c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .4.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z" />
              </svg>
              Source
            </a>
            <span className={`pill${proxyConfigured ? ' on' : ''}`} title="Proxy status">
              <i className="dot" />
              <span>{proxyConfigured ? 'proxy: active' : 'proxy: not set'}</span>
            </span>
            <button className="icon-btn" aria-label="Settings" title="Settings" onClick={() => setSettingsOpen(true)}>
              ⚙
            </button>
          </nav>
        </header>

        <main className="wrap">
          <SearchBar
            url={url}
            setUrl={setUrl}
            mode={mode}
            setMode={changeMode}
            loading={loading}
            onSubmit={handleFetch}
            onPaste={handlePaste}
            onClear={handleClear}
            inputRef={inputRef}
          />

          {post && <ResultCard post={post} downloading={downloading} onDownload={handleDownload} />}
          {progress && <ProgressCard p={progress} />}
          {files.length > 0 && <FilesCard files={files} />}

          <div className="features">
            <div className="feat">
              <span className="feat-ic">🎬</span>
              <h4>Videos</h4>
              <p>Best resolution, no watermark, pick any format.</p>
            </div>
            <div className="feat">
              <span className="feat-ic">🖼️</span>
              <h4>Slideshows</h4>
              <p>Every photo of a post, plus the audio track.</p>
            </div>
            <div className="feat">
              <span className="feat-ic">🌐</span>
              <h4>Proxy fallback</h4>
              <p>Add your residential proxy to beat IP blocks.</p>
            </div>
            <div className="feat">
              <span className="feat-ic">⚡</span>
              <h4>Live progress</h4>
              <p>Real-time speed, size and ETA as it downloads.</p>
            </div>
          </div>
        </main>

        <footer className="foot">
          <span>Respect creators' rights — download only what you're permitted to.</span>
        </footer>
      </div>

      {settingsOpen && (
        <SettingsModal
          configured={proxyConfigured}
          onClose={() => setSettingsOpen(false)}
          onSaved={(configured) => {
            setProxyConfigured(configured);
            push('ok', 'Proxy saved.');
          }}
          onError={(msg) => push('err', `Could not set proxy: ${msg}`)}
        />
      )}

      {exploreOpen && <ExploreModal onClose={() => setExploreOpen(false)} onPick={handlePick} />}

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
