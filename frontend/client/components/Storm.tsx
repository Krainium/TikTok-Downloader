const BOLT = 'M55 4 L24 96 L47 96 L38 196 L82 78 L56 78 Z';

/** Dimmed ambient lightning: a soft flash plus two bolts that flicker on/off. */
export function Storm() {
  return (
    <div className="storm" aria-hidden="true">
      <div className="flash" />
      <svg className="bolt bolt-a" viewBox="0 0 100 200" fill="none">
        <path d={BOLT} />
      </svg>
      <svg className="bolt bolt-b" viewBox="0 0 100 200" fill="none">
        <path d={BOLT} />
      </svg>
    </div>
  );
}
