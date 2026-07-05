import { useEffect, useState } from 'react';
import type { PostInfo } from '../types';
import { humanBytes, humanDuration } from '../format';

interface Props {
  post: PostInfo;
  downloading: boolean;
  onDownload: (opts: { formatId?: string; withAudio: boolean }) => void;
}

export function ResultCard({ post, downloading, onDownload }: Props) {
  const isVideo = post.kind === 'video';
  const formats = post.formats ?? [];
  const [formatId, setFormatId] = useState<string>(formats[0]?.formatId ?? '');
  const [withAudio, setWithAudio] = useState(true);

  // Reset selection whenever a new post is loaded.
  useEffect(() => {
    setFormatId(formats[0]?.formatId ?? '');
    setWithAudio(true);
  }, [post.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="card result">
      {post.thumbnail && (
        <img
          className={`thumb${isVideo ? '' : ' wide'}`}
          src={post.thumbnail}
          alt=""
          loading="lazy"
        />
      )}
      <div className="result-body">
        <span className="kind-badge">{isVideo ? '● Video' : '◆ Photo post'}</span>
        <h2>{post.title}</h2>
        {post.uploader && <p className="by">@{post.uploader}</p>}

        <div className="meta-tags">
          {post.usedProxy && <span className="tag">via proxy</span>}
          {isVideo && post.durationSec != null && (
            <span className="tag">⏱ {humanDuration(post.durationSec)}</span>
          )}
          {isVideo && <span className="tag">{formats.length} format(s)</span>}
          {!isVideo && <span className="tag">{post.imageCount} image(s)</span>}
          {!isVideo && post.hasAudio && <span className="tag">♪ audio</span>}
        </div>

        {!isVideo && post.images && post.images.length > 0 && (
          <div className="img-grid">
            {post.images.slice(0, 12).map((im, i) => (
              <img key={i} src={im.thumb} alt={`image ${i + 1}`} loading="lazy" />
            ))}
          </div>
        )}

        <div className="opt-row">
          {isVideo ? (
            <div className="select-wrap">
              <select value={formatId} onChange={(e) => setFormatId(e.target.value)}>
                {formats.map((f) => (
                  <option key={f.formatId} value={f.formatId}>
                    {[
                      f.resolution || f.formatId,
                      f.vcodec ?? '',
                      f.tbr ? `${f.tbr}kbps` : '',
                      f.filesize ? humanBytes(f.filesize) : '',
                      f.watermarked ? '· watermark' : '',
                    ]
                      .filter(Boolean)
                      .join('  ')}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            post.hasAudio && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={withAudio}
                  onChange={(e) => setWithAudio(e.target.checked)}
                />
                Also download audio track
              </label>
            )
          )}

          <button
            className="primary-btn"
            disabled={downloading}
            onClick={() => onDownload({ formatId: isVideo ? formatId : undefined, withAudio })}
          >
            {downloading ? <span className="spinner" /> : <span>⬇ Download</span>}
          </button>
        </div>
      </div>
    </section>
  );
}
