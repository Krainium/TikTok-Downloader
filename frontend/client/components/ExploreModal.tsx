import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { ExploreItem } from '../types';

interface Props {
  onClose: () => void;
  onPick: (url: string) => void;
}

/**
 * "For You"-style slideshow. Items + previews are resolved live from TikTok's
 * official oEmbed endpoint (server-side), so thumbnails/titles are current and
 * dead links are dropped. Auto-advances; pick a slide to test it instantly.
 */
export function ExploreModal({ onClose, onPick }: Props) {
  const [items, setItems] = useState<ExploreItem[]>([]);
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    api
      .explore()
      .then((r) => setItems(r.items))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Auto-advance every 5s (paused when fewer than two slides).
  useEffect(() => {
    if (items.length < 2) return;
    timer.current = window.setInterval(() => setIdx((i) => (i + 1) % items.length), 5000);
    return () => window.clearInterval(timer.current);
  }, [items.length]);

  const go = (d: number) => {
    window.clearInterval(timer.current);
    setIdx((i) => (i + d + items.length) % items.length);
  };

  const cur = items[idx];

  return (
    <div className="modal">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-card explore-card" role="dialog" aria-modal="true" aria-label="Explore trending">
        <div className="modal-head">
          <h3>✨ Explore — live from TikTok</h3>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="field-hint" style={{ marginTop: 0 }}>
          Pick a fresh sample to test the downloader instantly — previews load live, no hunting required.
        </p>

        {loading ? (
          <div className="explore-stage">
            <span className="spinner" style={{ borderTopColor: 'var(--cyan)' }} />
          </div>
        ) : !cur ? (
          <div className="explore-stage">
            <p className="field-hint">Couldn't reach TikTok for live samples right now — try again shortly.</p>
          </div>
        ) : (
          <>
            <div className="explore-stage">
              <button className="slide-nav prev" aria-label="Previous" onClick={() => go(-1)}>
                ‹
              </button>

              <div className="slide" key={cur.url}>
                {cur.thumb ? (
                  <img className="slide-thumb" src={cur.thumb} alt="" />
                ) : (
                  <div className="slide-thumb placeholder">
                    <span className="ph-note">♪</span>
                  </div>
                )}
                <div className="slide-meta">
                  <span className="kind-badge">● Live</span>
                  <div className="slide-title">{cur.title}</div>
                  {cur.author && <div className="slide-by">@{cur.author}</div>}
                  <button className="primary-btn" onClick={() => onPick(cur.url)}>
                    ⬇ Use this link
                  </button>
                </div>
              </div>

              <button className="slide-nav next" aria-label="Next" onClick={() => go(1)}>
                ›
              </button>
            </div>

            <div className="dots">
              {items.map((_, i) => (
                <button
                  key={i}
                  className={`dot${i === idx ? ' on' : ''}`}
                  aria-label={`Slide ${i + 1}`}
                  onClick={() => {
                    window.clearInterval(timer.current);
                    setIdx(i);
                  }}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
