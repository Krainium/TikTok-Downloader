import type { FileType, SavedFileInfo } from '../types';
import { humanBytes } from '../format';

const ICON: Record<FileType, string> = { video: '🎬', image: '🖼️', audio: '♪' };

export function FilesCard({ files }: { files: SavedFileInfo[] }) {
  if (files.length === 0) return null;
  return (
    <section className="card files-card">
      <div className="files-head">
        <h3>✓ Ready to save</h3>
        {files.length > 1 && (
          <a
            className="primary-btn small"
            href={files[0]!.url}
            onClick={(e) => {
              // Trigger each download in sequence (browsers throttle, so stagger).
              e.preventDefault();
              files.forEach((f, i) => {
                window.setTimeout(() => {
                  const a = document.createElement('a');
                  a.href = f.url;
                  a.download = f.name;
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                }, i * 350);
              });
            }}
          >
            Download all
          </a>
        )}
      </div>
      <div className="files-list">
        {files.map((f) => (
          <div className="file-item" key={f.index}>
            <span className="fi-ic">{ICON[f.type]}</span>
            <div className="fi-meta">
              <div className="fi-name">{f.name}</div>
              <div className="fi-sub">
                {f.type} · {humanBytes(f.size)}
              </div>
            </div>
            <a className="dl" href={f.url} download={f.name}>
              Save
            </a>
          </div>
        ))}
      </div>
    </section>
  );
}
