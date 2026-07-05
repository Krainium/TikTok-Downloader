/** Shared presentation helpers for post metadata & results. */
import path from 'node:path';
import * as c from './colors.js';
import { rankFormats } from './extractor.js';
import { humanBytes, humanDuration, resolutionLabel } from './util.js';
import type { TikTokPost } from './types.js';

/** Pretty-print a post's metadata and what will be downloaded. */
export function printPostSummary(post: TikTokPost): void {
  c.log.plain();
  c.log.plain(c.divider());
  const kind =
    post.kind === 'video' ? c.ttPink('● VIDEO post') : c.ttCyan('▣ IMAGE post');
  c.log.plain(`  ${kind}${post.usedProxy ? c.dim('   via proxy') : ''}`);
  c.log.plain('  ' + c.label('Title', post.title));
  if (post.uploader) c.log.plain('  ' + c.label('Author', '@' + post.uploader));
  c.log.plain('  ' + c.label('ID', post.id));

  if (post.kind === 'video') {
    if (post.durationSec !== undefined)
      c.log.plain('  ' + c.label('Duration', humanDuration(post.durationSec)));
    const ranked = rankFormats(post.formats);
    c.log.plain('  ' + c.label('Formats', String(ranked.length)));
    const best = ranked[0];
    if (best)
      c.log.plain(
        '  ' +
          c.label(
            'Best',
            `${best.formatId}  ${resolutionLabel(best) || '?'}  ${best.vcodec ?? '?'}  ${humanBytes(
              best.filesize,
            )}${best.watermarked ? c.yellow(' (watermarked)') : ''}`,
          ),
      );
  } else {
    c.log.plain('  ' + c.label('Images', String(post.images.length)));
    c.log.plain('  ' + c.label('Audio', post.audio ? 'available' : 'none'));
  }
  c.log.plain(c.divider());
}

/** List the available video formats (for the "show formats" action). */
export function printFormats(post: TikTokPost): void {
  if (post.kind !== 'video') {
    c.log.info('This is an image post — no video formats.');
    return;
  }
  c.log.plain();
  c.log.plain(c.bold('  Available formats (best first):'));
  for (const f of rankFormats(post.formats)) {
    const tag = f.watermarked ? c.yellow('  [watermarked]') : '';
    c.log.plain(
      `   ${c.ttCyan(f.formatId.padEnd(22))} ${(resolutionLabel(f) || '?').padStart(10)}  ` +
        `${(f.vcodec ?? '?').padEnd(6)}  ${humanBytes(f.filesize).padStart(9)}${tag}`,
    );
  }
  c.log.plain();
}

/** Report saved files. */
export function printSaved(paths: string[]): void {
  c.log.plain();
  c.log.ok(`Done — ${c.bold(String(paths.length))} file(s) saved:`);
  for (const p of paths) {
    c.log.plain(`   ${c.green('→')} ${c.white(p)}  ${c.dim('(' + path.basename(p) + ')')}`);
  }
  c.log.plain();
}
