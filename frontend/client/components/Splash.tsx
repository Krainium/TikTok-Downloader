interface Props {
  hide: boolean;
}

/** Animated brand splash screen shown on first load, then faded out. */
export function Splash({ hide }: Props) {
  return (
    <div className={`splash${hide ? ' hide' : ''}`} aria-hidden={hide}>
      <div className="splash-inner">
        <div className="logo-mark">
          <span className="note">♪</span>
        </div>
        <div className="wordmark">
          <span className="w1">Tik</span>
          <span className="w2">Tok</span>
          <span className="dl">Downloader</span>
        </div>
        <div className="splash-bar">
          <i />
        </div>
        <p className="splash-tag">Video &amp; Image · best quality · no watermark</p>
      </div>
      <div className="splash-glow g1" />
      <div className="splash-glow g2" />
    </div>
  );
}
