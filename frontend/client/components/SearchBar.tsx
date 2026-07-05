import type { RefObject } from 'react';
import type { ProxyMode } from '../types';

interface Props {
  url: string;
  setUrl: (v: string) => void;
  mode: ProxyMode;
  setMode: (m: ProxyMode) => void;
  loading: boolean;
  onSubmit: () => void;
  onPaste: () => void;
  onClear: () => void;
  inputRef: RefObject<HTMLInputElement>;
}

const MODES: { id: ProxyMode; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'direct', label: 'Direct' },
  { id: 'proxy', label: 'Proxy' },
];

export function SearchBar({ url, setUrl, mode, setMode, loading, onSubmit, onPaste, onClear, inputRef }: Props) {
  return (
    <section className="hero">
      <h1 className="title">
        Download <span className="grad">TikTok</span> videos &amp; photos
      </h1>
      <p className="subtitle">
        Paste a link to a video or a photo slideshow. Best non-watermarked quality, straight to your
        device.
      </p>

      <form
        className="searchbar"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <span className="search-icon">🔗</span>
        <input
          ref={inputRef}
          type="text"
          inputMode="url"
          spellCheck={false}
          placeholder="https://www.tiktok.com/@user/video/…"
          aria-label="TikTok URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        {url && (
          <button
            type="button"
            className="clear-btn"
            aria-label="Clear link and start over"
            title="Clear"
            onClick={onClear}
          >
            ✕
          </button>
        )}
        <button type="button" className="ghost-btn" title="Paste from clipboard" onClick={onPaste}>
          Paste
        </button>
        <button type="submit" className="primary-btn" disabled={loading}>
          {loading ? <span className="spinner" /> : <span className="btn-label">Fetch</span>}
        </button>
      </form>

      <div className="mode-row">
        <span className="mode-label">Connection</span>
        <div className="chips" role="tablist" aria-label="Proxy mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={mode === m.id}
              className={`chip${mode === m.id ? ' active' : ''}`}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
