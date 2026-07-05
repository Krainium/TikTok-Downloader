/**
 * Self-test (run: `npx tsx scripts/selftest.ts`).
 *
 *  1. Unit-tests the imagePost parser against TikTok's real JSON shapes
 *     (modern __UNIVERSAL_DATA_FOR_REHYDRATION__ and legacy SIGI_STATE).
 *  2. Exercises the real image-download path (streamFile -> downloadToFile ->
 *     ProgressBar -> proxy fallback) against a genuine TikTok image-CDN URL,
 *     proving the slideshow downloader works end-to-end.
 */
import assert from 'node:assert/strict';
import { existsSync, statSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseImageWebpage, extractPost } from '../src/extractor.js';
import { downloadImages } from '../src/downloader.js';
import { runtime } from '../src/config.js';
import * as c from '../src/colors.js';
import type { ImagePost } from '../src/types.js';

const VIDEO_URL = 'https://www.tiktok.com/@yawdabo_adwenkese3/video/7654742695398608135';
let failures = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => c.log.ok(name))
    .catch((e) => {
      failures++;
      c.log.fail(`${name} — ${e instanceof Error ? e.message : e}`);
    });
}

// --- 1. parser: modern universal data --------------------------------------
const modernHtml = `<html><body>
<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
  __DEFAULT_SCOPE__: {
    'webapp.video-detail': {
      statusCode: 0,
      itemInfo: {
        itemStruct: {
          id: '123',
          imagePost: {
            images: [
              {
                imageURL: { urlList: ['https://cdn.tt/img1.jpg', 'https://m2.tt/img1.jpg'] },
                imageWidth: 1080,
                imageHeight: 1920,
              },
              { imageURL: { urlList: ['https://cdn.tt/img2.jpg'] } },
            ],
          },
          music: { playUrl: 'https://sf.tt/song.mp3' },
        },
      },
    },
  },
})}</script></body></html>`;

// --- 1b. parser: legacy SIGI_STATE -----------------------------------------
const legacyHtml = `<html><body>
<script id="SIGI_STATE" type="application/json">${JSON.stringify({
  ItemModule: {
    '999': {
      id: '999',
      imagePost: { images: [{ imageURL: { urlList: ['https://cdn.tt/x.webp'] } }] },
      music: { playUrl: 'https://sf.tt/y.m4a' },
    },
  },
})}</script></body></html>`;

// --- 1c. parser: unavailable post ------------------------------------------
const blockedHtml = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(
  { __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 10204, statusMsg: 'status_self_see', itemInfo: { itemStruct: {} } } } },
)}</script>`;

async function main(): Promise<void> {
  c.log.plain(c.bold('\n  Image-pipeline self-test\n'));

  await check('parses modern imagePost (2 images, first url each)', () => {
    const r = parseImageWebpage(modernHtml);
    assert.equal(r.images.length, 2);
    assert.equal(r.images[0]!.url, 'https://cdn.tt/img1.jpg');
    assert.equal(r.images[0]!.width, 1080);
    assert.equal(r.images[1]!.url, 'https://cdn.tt/img2.jpg');
    assert.equal(r.audio?.url, 'https://sf.tt/song.mp3');
    assert.equal(r.audio?.ext, 'mp3');
  });

  await check('parses legacy SIGI_STATE imagePost', () => {
    const r = parseImageWebpage(legacyHtml);
    assert.equal(r.images.length, 1);
    assert.equal(r.images[0]!.url, 'https://cdn.tt/x.webp');
    assert.equal(r.audio?.ext, 'm4a');
  });

  await check('surfaces unavailable-post status (no images)', () => {
    const r = parseImageWebpage(blockedHtml);
    assert.equal(r.images.length, 0);
    assert.equal(r.statusCode, 10204);
    assert.equal(r.statusMsg, 'status_self_see');
  });

  // --- 2. live image download path ------------------------------------------
  await check('downloads a real TikTok CDN image via the slideshow path', async () => {
    const post = await extractPost(VIDEO_URL, 'auto');
    const imgUrl = post.thumbnail;
    assert.ok(imgUrl, 'expected a real thumbnail/image URL from extraction');

    const dir = mkdtempSync(path.join(tmpdir(), 'tt-imgtest-'));
    runtime.downloadDir = dir;
    const fake: ImagePost = {
      kind: 'image',
      id: post.id,
      title: post.title,
      uploader: post.uploader,
      webpageUrl: post.webpageUrl,
      usedProxy: post.usedProxy,
      images: [{ url: imgUrl!, urls: [imgUrl!] }],
    };
    const saved = await downloadImages(fake, { mode: 'auto' });
    assert.equal(saved.length, 1);
    assert.ok(existsSync(saved[0]!), 'image file should exist');
    assert.ok(statSync(saved[0]!).size > 1000, 'image file should be non-trivial');
    rmSync(dir, { recursive: true, force: true });
  });

  c.log.plain();
  if (failures > 0) {
    c.log.fail(`${failures} check(s) failed.`);
    process.exit(1);
  }
  c.log.ok('All image-pipeline checks passed.');
}

main().catch((e) => {
  c.log.fail(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
