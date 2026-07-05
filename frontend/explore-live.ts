/**
 * Live trending feed via a real browser (Playwright + Chromium).
 *
 * Rather than hand-rolling TikTok's request signing (X-Bogus / msToken /
 * _signature) — which is brittle and breaks whenever TikTok rotates it — we
 * drive a real headless Chromium to tiktok.com/explore and capture the
 * `/api/explore/item_list/` XHR the page's own (signed) JS fires. The browser
 * computes every signature for us, so the feed rotates automatically.
 *
 * A single browser is launched lazily and reused; each refresh uses a fresh
 * context (clean session → fresh trending). Routes through the configured
 * residential proxy when set. Falls back silently (caller handles empty).
 */
import type { Browser } from 'playwright';
import { PROXY, proxyConfigured } from '../src/config.js';

export interface LiveItem {
  url: string;
  title: string;
  author: string;
  thumb: string | null;
}

// A current desktop-Chrome UA so TikTok serves the normal web app.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;
let launchedSig = ''; // proxy snapshot the live browser was launched with

const proxySig = (): string => (proxyConfigured() ? `${PROXY.host}:${PROXY.port}:${PROXY.user}` : 'direct');

async function getBrowser(): Promise<Browser> {
  const sig = proxySig();
  if (browser?.isConnected() && launchedSig === sig) return browser;
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  if (launching) return launching;
  // Imported lazily so the server still boots if Playwright isn't installed
  // (the caller catches the throw and falls back to the oEmbed seed pool).
  launching = (async () => {
    const { chromium } = await import('playwright');
    const b = await chromium.launch({
      headless: true,
      // Memory-frugal flags so Chromium fits in a 512 MB container (single-process
      // collapses the renderer/browser into one process — much lower RAM).
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--single-process',
        '--no-zygote',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-features=site-per-process,TranslateUI',
        '--js-flags=--max-old-space-size=256',
      ],
      proxy: proxyConfigured()
        ? { server: `http://${PROXY.host}:${PROXY.port}`, username: PROXY.user, password: PROXY.pass }
        : undefined,
    });
    browser = b;
    launchedSig = sig;
    b.on('disconnected', () => {
      if (browser === b) browser = null;
    });
    return b;
  })();
  try {
    return await launching;
  } finally {
    launching = null;
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const coverOf = (video: Record<string, unknown> | undefined): string => {
  for (const k of ['cover', 'originCover', 'dynamicCover']) {
    const v = video?.[k];
    if (typeof v === 'string' && v) return v;
    const list = (v as { urlList?: unknown })?.urlList;
    if (Array.isArray(list) && typeof list[0] === 'string') return list[0];
  }
  return '';
};

function normalize(it: Record<string, any>): LiveItem | null {
  const id = str(it.id) || str(it.aweme_id);
  const author = str(it.author?.uniqueId) || str(it.author?.unique_id);
  if (!id || !author) return null;
  const cover = coverOf(it.video);
  return {
    url: `https://www.tiktok.com/@${author}/video/${id}`,
    title: str(it.desc).trim() || 'TikTok video',
    author,
    thumb: cover ? `/api/thumb?url=${encodeURIComponent(cover)}` : null,
  };
}

/**
 * Drive Chromium to tiktok.com/explore and collect up to `limit` trending
 * items from the captured item_list responses. Resolves to [] on failure
 * (captcha wall, timeout, …) so the caller can fall back.
 */
export async function fetchLiveTrending(limit = 12, timeoutMs = 40_000): Promise<LiveItem[]> {
  const b = await getBrowser();
  const ctx = await b.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await ctx.newPage();

  const items: LiveItem[] = [];
  const seen = new Set<string>();
  page.on('response', async (res) => {
    if (!/tiktok\.com\/api\/(explore|recommend)\/item_list/i.test(res.url())) return;
    try {
      const j = (await res.json()) as { itemList?: Record<string, any>[] };
      for (const it of j.itemList ?? []) {
        const n = normalize(it);
        if (n && !seen.has(n.url)) {
          seen.add(n.url);
          items.push(n);
        }
      }
    } catch {
      /* non-JSON / partial */
    }
  });

  try {
    await page.goto('https://www.tiktok.com/explore', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const deadline = Date.now() + timeoutMs;
    // The first item_list response usually returns ~16 items; scroll to top up.
    while (items.length < limit && Date.now() < deadline) {
      await page.mouse.wheel(0, 2600);
      await page.waitForTimeout(1200);
    }
  } catch {
    /* nav timeout / block — return whatever we captured (often []) */
  } finally {
    await ctx.close().catch(() => {});
  }
  return items.slice(0, limit);
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}
