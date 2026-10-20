// Collects everything the Chrome Web Store submission needs into one folder:
//   release/chrome-web-store-<version>/
//     1-upload-this.zip              the package (built by `node scripts/build.mjs --store`)
//     SUBMIT.html / SUBMIT.md        every dashboard field under its exact label, ready to paste (Copy buttons in .html),
//                                    each marked with the release it last changed in (store/listing-history.json)
//     PRIVACY.md                     the privacy policy (also published on levac.net)
//     images/store-icon-128.png      store icon
//     images/logo-512.png            the mark at 512 px, for the website and anywhere else
//     images/promo-tile-440x280.png  small promo tile
//     images/marquee-1400x560.png    marquee promo tile
//     images/screenshots/            five 1280x800 screenshots
// The screenshots run the real, built content script and settings page on a mock Gmail of made-up emails
// (store/mock-gmail.html), with ChatGPT and the Gmail API replaced by scripted scenes (store/stub.js).
// Run through `npm run package`, after the store build.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { renderIcon } from './icons.mjs';
import { imageFiles, lineage, readHistory, record, snapshot, thumbnails, writeHistory } from './listing-history.mjs';
import { SCREENSHOTS, storeListing } from './store-listing.mjs';
import { checkLimits, renderHtml, renderMarkdown } from './submit-page.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const dist = join(root, 'dist-store');
const zip = join(root, 'release', `inbox-pilot-${version}.zip`);
if (!existsSync(zip) || !existsSync(join(dist, 'content.js'))) throw new Error('Run the store build first: node scripts/build.mjs --store');

const out = join(root, 'release', `chrome-web-store-${version}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'images', 'screenshots'), { recursive: true });

renameSync(zip, join(out, '1-upload-this.zip')); // moved, so release/ holds only this folder
copyFileSync(join(dist, 'icons', 'icon128.png'), join(out, 'images', 'store-icon-128.png'));
writeFileSync(join(out, 'images', 'logo-512.png'), renderIcon(512));
copyFileSync(join(root, 'PRIVACY.md'), join(out, 'PRIVACY.md'));

const tabs = storeListing(version);
checkLimits(tabs);

// Pages are served from a made-up origin: dist-store/ and store/ files, with the stub loaded before the settings page.
const ORIGIN = 'https://inboxpilot.store.test';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

async function serve(context) {
  await context.route(`${ORIGIN}/**`, async (route) => {
    const name = new URL(route.request().url()).pathname.slice(1) || 'mock-gmail.html';
    const file = [join(root, 'store', name), join(dist, name)].find((f) => existsSync(f));
    if (!file) return route.fulfill({ status: 404, body: 'not found' });
    let body = readFileSync(file);
    if (name === 'options.html') body = Buffer.from(body.toString('utf8').replace('<script src="force-motion.js"></script>', '<script src="stub.js"></script><script src="force-motion.js"></script>'));
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? 'application/octet-stream', body });
  });
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'light' });
  await serve(context);
  const page = await context.newPage();

  const scenes = [
    ['ask', SCREENSHOTS[0]],
    ['attachment', SCREENSHOTS[1]],
    ['organize', SCREENSHOTS[2]],
    ['draft', SCREENSHOTS[3]],
  ];
  for (const [scene, file] of scenes) {
    await page.goto(`${ORIGIN}/mock-gmail.html?scene=${scene}`);
    if (scene === 'draft') await page.evaluate(() => document.body.classList.add('thread-view'));
    await page.waitForTimeout(400);
    const question = await page.evaluate(() => window.__storeQuestion);
    const box = page.locator('input[name="q"]');
    await box.click();
    await box.pressSequentially(question, { delay: 5 });
    await page.waitForTimeout(150);
    await box.press('Enter');
    await page.waitForTimeout(1500);
    // Nothing focused, so no caret blinks into the shot.
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await page.mouse.move(1270, 790);
    await page.screenshot({ path: join(out, 'images', 'screenshots', file) });
  }

  const settings = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'dark' });
  await serve(settings);
  const options = await settings.newPage();
  await options.goto(`${ORIGIN}/options.html`);
  await options.waitForTimeout(1200);
  await options.screenshot({ path: join(out, 'images', 'screenshots', SCREENSHOTS[4]) });
  await settings.close();

  // Promo tiles: the mark, the name, and what it is, on Inbox Pilot's sky gradient.
  const logo = renderIcon(256).toString('base64');
  const shot = readFileSync(join(out, 'images', 'screenshots', SCREENSHOTS[0])).toString('base64');
  const tile = (width, height, withShot) => `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;width:${width}px;height:${height}px;overflow:hidden;font-family:"Google Sans","Segoe UI",system-ui,sans-serif;color:#fff;
background:radial-gradient(900px 500px at 15% 0%,#5b9cff 0%,transparent 60%),linear-gradient(135deg,#2f6fe0 0%,#1747a6 70%,#123a8a 100%);
display:flex;align-items:center;gap:${withShot ? 48 : 22}px;padding:0 ${withShot ? 64 : 30}px;box-sizing:border-box}
img.logo{width:${withShot ? 132 : 92}px;height:${withShot ? 132 : 92}px;flex:none;filter:drop-shadow(0 10px 24px rgba(0,0,0,.35));border-radius:22%}
h1{font-size:${withShot ? 56 : 30}px;line-height:1.05;margin:0 0 ${withShot ? 16 : 8}px;font-weight:700;letter-spacing:-.01em}
p{margin:0;font-size:${withShot ? 24 : 15}px;line-height:1.35;color:#dbe7ff}
b{color:#fff}
.shot{margin-left:auto;width:560px;height:350px;border-radius:14px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.4);flex:none}
.shot img{width:1280px;transform:scale(.4375);transform-origin:0 0;display:block}
</style></head><body><img class="logo" src="data:image/png;base64,${logo}" alt=""><div><h1>Inbox Pilot</h1><p>Your <b>ChatGPT</b> at the controls of your <b>Gmail</b>: find, read, draft and tidy from the search bar.</p></div>${withShot ? `<div class="shot"><img src="data:image/png;base64,${shot}" alt=""></div>` : ''}</body></html>`;
  const promo = await browser.newPage({ viewport: { width: 440, height: 280 } });
  await promo.setContent(tile(440, 280, false));
  await promo.screenshot({ path: join(out, 'images', 'promo-tile-440x280.png') });
  await promo.setViewportSize({ width: 1400, height: 560 });
  await promo.setContent(tile(1400, 560, true));
  await promo.screenshot({ path: join(out, 'images', 'marquee-1400x560.png') });

  // Now that every image exists: record this release's fields and mark each with the release it last changed in.
  const historyFile = join(root, 'store', 'listing-history.json');
  const history = record(readHistory(historyFile), version, snapshot(tabs, await thumbnails(browser, out, imageFiles(tabs))));
  writeHistory(historyFile, history);
  const changes = lineage(history, version);
  writeFileSync(join(out, 'SUBMIT.html'), renderHtml(tabs, version, changes));
  writeFileSync(join(out, 'SUBMIT.md'), renderMarkdown(tabs, version, changes));
} finally {
  await browser.close();
}

console.log(`Chrome Web Store submission folder -> ${out}`);
