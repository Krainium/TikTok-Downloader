/** Colourful live download progress bar (single line, in-place). */
import { ttCyan, ttPink, bold, dim, gray, green, reset } from './colors.js';
import { humanBytes, humanSpeed, humanDuration } from './util.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// CSI SGR colour sequence, e.g. "\x1b[38;2;…m". Used to measure/trim visible width.
const ANSI = /\x1b\[[0-9;]*m/;
const ANSI_G = new RegExp(ANSI.source, 'g');
const CLEAR_EOL = '\x1b[K'; // erase from cursor to end of line

/** Visible width of a string, ignoring ANSI colour codes. */
function visibleLen(s: string): number {
  return s.replace(ANSI_G, '').length;
}

/**
 * Truncate `s` to at most `max` *visible* columns, keeping colour codes intact
 * (so colours never bleed). Appends `…` when `ellipsis` and truncation happened.
 */
function clampVisible(s: string, max: number, ellipsis = false): string {
  if (max <= 0) return '';
  if (visibleLen(s) <= max) return s;
  const budget = ellipsis ? max - 1 : max;
  let out = '';
  let vis = 0;
  for (let i = 0; i < s.length && vis < budget; ) {
    if (s[i] === '\x1b') {
      const m = ANSI.exec(s.slice(i));
      if (m && m.index === 0) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += s[i];
    vis++;
    i++;
  }
  return out + (ellipsis ? '…' : '') + reset;
}

export class ProgressBar {
  private readonly start = Date.now();
  private lastRenderAt = 0;
  private lastPct = -1;
  private spin = 0;
  private drew = false;
  private finished = false;
  private readonly tty: boolean;

  constructor(
    private readonly label: string,
    private readonly width = 26,
  ) {
    this.tty = Boolean(process.stdout.isTTY);
  }

  /** Usable terminal width (columns), with a sane fallback for odd environments. */
  private cols(): number {
    const c = process.stdout.columns;
    return c && c > 20 ? c : 80;
  }

  /** Fit `label + tail` into one terminal row by trimming the (variable) label. */
  private fit(label: string, tail: string): string {
    const labelMax = this.cols() - 1 - visibleLen(tail);
    return clampVisible(label, labelMax, true) + tail;
  }

  /**
   * @param downloaded bytes received so far
   * @param total      total bytes if known
   * @param speed      bytes/sec (optional; otherwise derived from elapsed time)
   */
  update(downloaded: number, total?: number, speed?: number): void {
    if (this.finished) return;
    const now = Date.now();
    const pct =
      total && total > 0 ? Math.min(100, Math.floor((downloaded / total) * 100)) : -1;

    // Throttle: redraw at most ~every 90ms, but never skip a percentage change.
    const throttled = now - this.lastRenderAt < 90 && pct === this.lastPct;
    if (throttled) return;
    this.lastRenderAt = now;
    this.lastPct = pct;

    const elapsed = (now - this.start) / 1000;
    const rate = speed ?? (elapsed > 0 ? downloaded / elapsed : 0);
    this.draw(this.compose(downloaded, total, pct, rate));
  }

  private compose(
    downloaded: number,
    total: number | undefined,
    pct: number,
    rate: number,
  ): string {
    const size =
      total && total > 0
        ? `${humanBytes(downloaded)}/${humanBytes(total)}`
        : humanBytes(downloaded);
    const speedStr = gray(humanSpeed(rate));

    if (pct < 0) {
      // Unknown total — spinner mode.
      const frame = SPINNER[this.spin++ % SPINNER.length] ?? '⠋';
      return this.fit(`${ttCyan(frame)} ${this.label}`, `  ${bold(size)}  ${speedStr}`);
    }

    const filledN = Math.round((pct / 100) * this.width);
    const bar = ttCyan('█'.repeat(filledN)) + gray('░'.repeat(this.width - filledN));
    const eta = rate > 0 && total ? (total - downloaded) / rate : undefined;
    const pctStr = bold(ttPink(`${String(pct).padStart(3)}%`));
    const tail =
      ` [${bar}] ${pctStr}  ${bold(size)}  ${speedStr}  ${dim('ETA ' + humanDuration(eta))}`;
    return this.fit(this.label, tail);
  }

  private draw(line: string): void {
    if (this.tty) {
      // Clamp to the row width (backstop) and clear to EOL so nothing wraps or
      // leaves leftovers — the bar stays on a single, self-overwriting line.
      const safe = clampVisible(line, this.cols() - 1);
      process.stdout.write('\r' + safe + CLEAR_EOL);
      this.drew = true;
    } else {
      // Non-interactive (piped/captured): emit discrete lines.
      process.stdout.write(line + '\n');
    }
  }

  /** Mark complete: render a final 100% bar + checkmark, then newline. */
  finish(totalBytes?: number, label = 'done'): void {
    if (this.finished) return;
    this.finished = true;
    const elapsed = (Date.now() - this.start) / 1000;
    const bar = ttCyan('█'.repeat(this.width));
    const size = humanBytes(totalBytes);
    const avg = totalBytes && elapsed > 0 ? humanSpeed(totalBytes / elapsed) : '—';
    const tail =
      ` [${bar}] ${bold(green('100%'))}  ` +
      `${bold(size)}  ${gray(avg)}  ${dim('in ' + humanDuration(elapsed))}  ${green('✔ ' + label)}`;
    const line = this.fit(this.label, tail);
    if (this.tty) {
      process.stdout.write('\r' + clampVisible(line, this.cols() - 1) + CLEAR_EOL + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }

  /** Abandon the bar (on error) so subsequent output starts on a clean line. */
  abort(): void {
    if (this.finished) return;
    this.finished = true;
    // Erase the partial bar so the retry/error message replaces it cleanly.
    if (this.tty && this.drew) process.stdout.write('\r' + CLEAR_EOL);
  }
}
