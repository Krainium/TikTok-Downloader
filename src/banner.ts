/** ASCII art banner — printed at startup, TikTok brand colours. */
import { ttCyan, ttPink, dim, gray, bold } from './colors.js';

const ART = [
  ' ████████╗██╗██╗  ██╗████████╗ ██████╗ ██╗  ██╗',
  ' ╚══██╔══╝██║██║ ██╔╝╚══██╔══╝██╔═══██╗██║ ██╔╝',
  '    ██║   ██║█████╔╝    ██║   ██║   ██║█████╔╝ ',
  '    ██║   ██║██╔═██╗    ██║   ██║   ██║██╔═██╗ ',
  '    ██║   ██║██║  ██╗   ██║   ╚██████╔╝██║  ██╗',
  '    ╚═╝   ╚═╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝',
];

const WIDTH = 49;

export function printBanner(): void {
  console.log();
  // Alternate the two brand colours line by line for a subtle gradient feel.
  ART.forEach((line, i) => {
    const paint = i % 2 === 0 ? ttCyan : ttPink;
    console.log(' ' + paint(line));
  });
  const title = 'Video and Image Downloader';
  const pad = Math.max(0, Math.floor((WIDTH - title.length) / 2));
  console.log(' ' + ' '.repeat(pad) + bold(ttPink(title)));
  console.log(' ' + gray('─'.repeat(WIDTH)));
  console.log(
    ' ' +
      dim('by ') +
      ttCyan('Krainium') +
      dim('  •  native extractor') +
      dim('  •  residential proxy fallback'),
  );
  console.log();
}
