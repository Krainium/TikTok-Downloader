/**
 * Terminal styling — ANSI colours + semantic message helpers.
 *
 * Mirrors the `color.go` convention from the sibling Krainium repos: raw ANSI
 * codes are isolated, and higher-level helpers (`info`/`ok`/`warn`/`fail`)
 * attach a glyph + colour so callers express intent, not escape codes.
 *
 * Colour is auto-disabled when stdout is not a TTY or when NO_COLOR is set,
 * so piping the CLI into a file produces clean text.
 */

const enabled = (): boolean =>
  process.env.NO_COLOR === undefined && process.env.FORCE_COLOR !== '0';

const wrap = (open: string, close = '\x1b[0m') =>
  (s: string | number): string => (enabled() ? `${open}${s}${close}` : String(s));

// Basic styles
export const reset = '\x1b[0m';
export const bold = wrap('\x1b[1m');
export const dim = wrap('\x1b[2m');
export const italic = wrap('\x1b[3m');
export const underline = wrap('\x1b[4m');

// Foreground colours
export const red = wrap('\x1b[31m');
export const green = wrap('\x1b[32m');
export const yellow = wrap('\x1b[33m');
export const blue = wrap('\x1b[34m');
export const magenta = wrap('\x1b[35m');
export const cyan = wrap('\x1b[36m');
export const white = wrap('\x1b[37m');
export const gray = wrap('\x1b[90m');

// Bright variants
export const brightCyan = wrap('\x1b[96m');
export const brightMagenta = wrap('\x1b[95m');
export const brightGreen = wrap('\x1b[92m');

// TikTok brand truecolor accents (cyan #25F4EE, pink #FE2C55)
export const ttCyan = wrap('\x1b[38;2;37;244;238m');
export const ttPink = wrap('\x1b[38;2;254;44;85m');

/** Bold key + plain value, e.g. `Title: my video`. */
export const label = (key: string, value: string | number): string =>
  `${cyan(key + ':')} ${white(String(value))}`;

/** Horizontal rule. */
export const divider = (width = 56): string => gray('─'.repeat(width));

// Semantic, glyph-prefixed log helpers ---------------------------------------
export const info = (msg: string): string => `${cyan('ℹ')} ${msg}`;
export const ok = (msg: string): string => `${green('✔')} ${msg}`;
export const warn = (msg: string): string => `${yellow('⚠')} ${msg}`;
export const fail = (msg: string): string => `${red('✘')} ${msg}`;
export const step = (msg: string): string => `${ttCyan('➜')} ${msg}`;

// Convenience writers
export const log = {
  info: (m: string) => console.log(info(m)),
  ok: (m: string) => console.log(ok(m)),
  warn: (m: string) => console.log(warn(m)),
  fail: (m: string) => console.error(fail(m)),
  step: (m: string) => console.log(step(m)),
  plain: (m = '') => console.log(m),
};
