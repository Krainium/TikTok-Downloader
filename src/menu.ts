/** Interactive menu loop (backend CLI). */
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as c from './colors.js';
import { extractPost } from './extractor.js';
import { downloadPost } from './downloader.js';
import { printPostSummary, printFormats, printSaved } from './ui.js';
import { proxyDisplay, redact, proxyConfigured, setProxyFromString } from './config.js';
import type { ProxyMode } from './types.js';

const errMsg = (e: unknown): string => redact(e instanceof Error ? e.message : String(e));

export function isTikTokUrl(s: string): boolean {
  return /(?:^|\.)tiktok\.com\//i.test(s) || /\b(?:vm|vt)\.tiktok\.com\//i.test(s);
}

const modeLabel = (m: ProxyMode): string =>
  m === 'auto'
    ? c.green('auto') + c.dim(' (direct, proxy fallback)')
    : m === 'proxy'
      ? c.yellow('proxy') + c.dim(' (force proxy)')
      : c.cyan('direct') + c.dim(' (no proxy)');

const proxyLabel = (): string =>
  proxyConfigured() ? c.green(proxyDisplay()) : c.dim('not set');

function printMenu(mode: ProxyMode): void {
  c.log.plain();
  c.log.plain(c.bold('  What would you like to do?'));
  c.log.plain(`   ${c.ttPink('[1]')} Download TikTok ${c.bold('video')}`);
  c.log.plain(`   ${c.ttPink('[2]')} Download TikTok ${c.bold('images')} ${c.dim('(slideshow / photo)')}`);
  c.log.plain(`   ${c.ttPink('[3]')} ${c.bold('Auto-detect')} & download ${c.dim('(paste any link)')}`);
  c.log.plain(`   ${c.ttPink('[4]')} Show post ${c.bold('info / formats')}`);
  c.log.plain(`   ${c.ttPink('[5]')} Toggle ${c.bold('proxy mode')}  ${c.dim('current:')} ${modeLabel(mode)}`);
  c.log.plain(`   ${c.ttPink('[6]')} Set ${c.bold('residential proxy')}  ${c.dim('current:')} ${proxyLabel()}`);
  c.log.plain(`   ${c.ttPink('[q]')} Quit`);
}

function cycleMode(m: ProxyMode): ProxyMode {
  return m === 'auto' ? 'direct' : m === 'direct' ? 'proxy' : 'auto';
}

/** Warn if a proxy-using mode is active but no proxy has been entered yet. */
function warnIfProxyMissing(mode: ProxyMode): void {
  if (mode !== 'direct' && !proxyConfigured()) {
    c.log.warn('No proxy set yet — choose [6] to add yours (downloads stay direct until then).');
  }
}

/** Prompt for and store the user's residential proxy. */
async function setProxy(rl: readline.Interface): Promise<void> {
  c.log.plain(
    c.dim('  Enter your proxy as host:port:user:pass  (or http://user:pass@host:port). Blank to cancel.'),
  );
  const input = (await rl.question(c.cyan('  Proxy › '))).trim();
  if (!input) {
    c.log.warn('Cancelled — proxy unchanged.');
    return;
  }
  const err = setProxyFromString(input);
  if (err) {
    c.log.fail(`Could not set proxy: ${err}`);
    return;
  }
  c.log.ok(`Proxy set → ${proxyDisplay()}`);
}

async function askUrl(rl: readline.Interface): Promise<string | null> {
  const url = (await rl.question(c.cyan('  Paste TikTok URL › '))).trim();
  if (!url) {
    c.log.warn('No URL entered.');
    return null;
  }
  if (!isTikTokUrl(url)) {
    c.log.warn("That doesn't look like a TikTok URL — trying anyway.");
  }
  return url;
}

async function doDownload(
  rl: readline.Interface,
  mode: ProxyMode,
  want: 'video' | 'image' | 'auto',
): Promise<void> {
  const url = await askUrl(rl);
  if (!url) return;
  warnIfProxyMissing(mode);

  c.log.step('Extracting metadata…');
  let post;
  try {
    post = await extractPost(url, mode);
  } catch (e) {
    c.log.fail(`Extraction failed: ${errMsg(e)}`);
    return;
  }
  printPostSummary(post);

  if (want === 'video' && post.kind !== 'video')
    c.log.warn('Requested video, but this is an image post — downloading images.');
  if (want === 'image' && post.kind !== 'image')
    c.log.warn('Requested images, but this is a video post — downloading the video.');

  let withAudio = false;
  if (post.kind === 'image' && post.audio) {
    const ans = (await rl.question(c.cyan('  Also grab the audio track? [y/N] › ')))
      .trim()
      .toLowerCase();
    withAudio = ans === 'y' || ans === 'yes';
  }

  try {
    const saved = await downloadPost(post, { mode, withAudio });
    printSaved(saved);
  } catch (e) {
    c.log.fail(`Download failed: ${errMsg(e)}`);
  }
}

async function doInfo(rl: readline.Interface, mode: ProxyMode): Promise<void> {
  const url = await askUrl(rl);
  if (!url) return;
  warnIfProxyMissing(mode);
  c.log.step('Extracting metadata…');
  try {
    const post = await extractPost(url, mode);
    printPostSummary(post);
    printFormats(post);
  } catch (e) {
    c.log.fail(`Extraction failed: ${errMsg(e)}`);
  }
}

export async function runMenu(initialMode: ProxyMode = 'auto'): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  let mode: ProxyMode = initialMode;
  // Ctrl-C is handled process-wide in index.ts (kills downloads + exits).

  try {
    while (true) {
      printMenu(mode);
      const choice = (await rl.question(c.ttCyan('\n  Select › '))).trim().toLowerCase();
      if (choice === 'q' || choice === 'quit' || choice === 'exit') break;
      switch (choice) {
        case '1':
          await doDownload(rl, mode, 'video');
          break;
        case '2':
          await doDownload(rl, mode, 'image');
          break;
        case '3':
          await doDownload(rl, mode, 'auto');
          break;
        case '4':
          await doInfo(rl, mode);
          break;
        case '5':
          mode = cycleMode(mode);
          c.log.ok(`Proxy mode → ${modeLabel(mode)}`);
          warnIfProxyMissing(mode);
          break;
        case '6':
          await setProxy(rl);
          break;
        case '':
          break;
        default:
          c.log.warn(`Unknown option: ${choice}`);
      }
    }
  } catch (e) {
    // Readline closed (Ctrl-D / Ctrl-C) throws on pending question.
    if (errMsg(e) && !/closed/i.test(errMsg(e))) c.log.fail(errMsg(e));
  } finally {
    rl.close();
  }
  c.log.plain(c.dim('\n  Bye 👋'));
}
