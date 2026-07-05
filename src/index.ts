#!/usr/bin/env node
/**
 * Tiktok Video and Image Downloader — backend CLI entry point.
 *
 * Run with no URL  -> interactive menu.
 * Run with a URL   -> one-shot download (handy for scripting / tests).
 */
import path from 'node:path';
import { printBanner } from './banner.js';
import { runMenu, isTikTokUrl } from './menu.js';
import { extractPost } from './extractor.js';
import { downloadPost } from './downloader.js';
import { printPostSummary, printFormats, printSaved } from './ui.js';
import { runtime, redact } from './config.js';
import * as c from './colors.js';
import type { ProxyMode } from './types.js';

const errMsg = (e: unknown): string => redact(e instanceof Error ? e.message : String(e));

interface Cli {
  url?: string;
  mode: ProxyMode;
  want: 'video' | 'image' | 'auto';
  infoOnly: boolean;
  withAudio: boolean;
  formatId?: string;
  banner: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = {
    mode: 'auto',
    want: 'auto',
    infoOnly: false,
    withAudio: false,
    banner: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '-h':
      case '--help':
        cli.help = true;
        break;
      case '--video':
        cli.want = 'video';
        break;
      case '--images':
      case '--image':
        cli.want = 'image';
        break;
      case '--info':
        cli.infoOnly = true;
        break;
      case '--proxy':
        cli.mode = 'proxy';
        break;
      case '--direct':
        cli.mode = 'direct';
        break;
      case '--auto':
        cli.mode = 'auto';
        break;
      case '--audio':
        cli.withAudio = true;
        break;
      case '--no-banner':
        cli.banner = false;
        break;
      case '-f':
      case '--format':
        cli.formatId = argv[++i];
        break;
      case '-o':
      case '--out':
        runtime.downloadDir = path.resolve(argv[++i] ?? '.');
        break;
      case '--url':
        cli.url = argv[++i];
        break;
      default:
        if (!a.startsWith('-') && !cli.url) cli.url = a;
    }
  }
  return cli;
}

function printHelp(): void {
  printBanner();
  console.log(`${c.bold('Usage')}
  ${c.ttCyan('npm start')}                         ${c.dim('# interactive menu')}
  ${c.ttCyan('npm start -- <url> [options]')}      ${c.dim('# one-shot download')}

${c.bold('Options')}
  ${c.ttPink('--video')}        Treat the post as a video
  ${c.ttPink('--images')}       Treat the post as a slideshow / photo
  ${c.ttPink('--info')}         Only show metadata + available formats
  ${c.ttPink('--audio')}        Also download the audio track of an image post
  ${c.ttPink('-f, --format')}   format id (default: best non-watermarked)
  ${c.ttPink('-o, --out')}      Output directory ${c.dim(`(default: ${runtime.downloadDir})`)}
  ${c.ttPink('--proxy')}        Force the residential proxy
  ${c.ttPink('--direct')}       Never use the proxy
  ${c.ttPink('--auto')}         Direct first, proxy fallback ${c.dim('(default)')}
  ${c.ttPink('--no-banner')}    Suppress the banner
  ${c.ttPink('-h, --help')}     Show this help

${c.bold('Examples')}
  ${c.dim('npm start -- "https://www.tiktok.com/@user/video/123" --video')}
  ${c.dim('npm start -- "https://www.tiktok.com/@user/photo/123" --images --audio')}
`);
}

async function oneShot(cli: Cli): Promise<number> {
  if (cli.banner) printBanner();
  if (!isTikTokUrl(cli.url!)) c.log.warn("That doesn't look like a TikTok URL — trying anyway.");

  c.log.step('Extracting metadata…');
  const post = await extractPost(cli.url!, cli.mode);
  printPostSummary(post);

  if (cli.infoOnly) {
    printFormats(post);
    return 0;
  }
  if (cli.want === 'video' && post.kind !== 'video')
    c.log.warn('Requested video, but this is an image post — downloading images.');
  if (cli.want === 'image' && post.kind !== 'image')
    c.log.warn('Requested images, but this is a video post — downloading the video.');

  const saved = await downloadPost(post, {
    mode: cli.mode,
    formatId: cli.formatId,
    withAudio: cli.withAudio,
  });
  printSaved(saved);
  return 0;
}

async function main(): Promise<void> {
  // Ctrl-C: exit promptly (in-flight sockets are torn down on exit).
  process.on('SIGINT', () => {
    c.log.plain(c.dim('\n  Interrupted.'));
    process.exit(130);
  });

  const cli = parseArgs(process.argv.slice(2));

  if (cli.help) {
    printHelp();
    return;
  }

  if (cli.url) {
    try {
      process.exitCode = await oneShot(cli);
    } catch (e) {
      c.log.fail(errMsg(e));
      process.exitCode = 1;
    }
  } else {
    printBanner();
    await runMenu(cli.mode);
  }
}

main().catch((e) => {
  c.log.fail(errMsg(e));
  process.exitCode = 1;
});
