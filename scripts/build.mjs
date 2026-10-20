// Builds the unpacked extension.
//   node scripts/build.mjs          -> dist/      (load unpacked from here)
//   node scripts/build.mjs --store  -> dist-store/ and release/inbox-pilot-<version>.zip
//                                      (Chrome Web Store upload: the same build without the "key" field, which the
//                                      store rejects; the store assigns the extension its own ID)
//
// Configuration (none of it is secret, all of it stays out of git):
//   GMC_GOOGLE_CLIENT_ID   A Google OAuth client ID to use until the user saves their own in Options. For a personal
//                          build only: a store build must leave it empty, so every user brings their own Google app.
// or the same value in config/extension.config.json (see config/extension.config.example.json).
//
// The unpacked build's extension ID is pinned by config/extension-public-key.txt. That matters more here than
// usual: the Google OAuth redirect URI users register is https://<extension-id>.chromiumapp.org/, so a changing
// ID would break every user's Google setup. The matching private key was never kept: unpacked loading does not
// need it, and a Chrome Web Store listing brings its own key.
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderIcon } from './icons.mjs';
import { zipDirectory } from './zip.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = process.argv.includes('--store');
const outdir = join(root, store ? 'dist-store' : 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/**
 * The Codex CLI release whose model catalog the extension asks for. ChatGPT's backend hides models newer than
 * the client that asks, so bump this when OpenAI ships a new Codex release with new models.
 */
const CODEX_CLIENT_VERSION = '0.163.0';

/** Chrome derives the extension ID from the public key: first 16 bytes of SHA-256(DER), hex digits mapped to a-p. */
export function extensionIdFor(publicKey) {
  const hex = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export function createManifest({ publicKey }) {
  const icons = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
  const manifest = {
    manifest_version: 3,
    name: 'Inbox Pilot',
    version: pkg.version,
    description: 'Ask ChatGPT about your Gmail from the search bar: find anything, read attachments, draft replies and tidy your inbox.',
    // 140+: storage.local.setAccessLevel keeps the token store away from content scripts.
    minimum_chrome_version: '140',
    // offscreen: a hidden page that reads PDF attachments with pdf.js, created only when one is read.
    permissions: ['storage', 'identity', 'offscreen'],
    // oauth2.googleapis.com: only to revoke the Google token when the user disconnects Gmail.
    host_permissions: ['https://mail.google.com/*', 'https://gmail.googleapis.com/*', 'https://oauth2.googleapis.com/*', 'https://auth.openai.com/*', 'https://chatgpt.com/*'],
    background: { service_worker: 'background.js', type: 'module' },
    content_scripts: [{ matches: ['https://mail.google.com/mail/*'], js: ['content.js'], run_at: 'document_idle' }],
    options_ui: { page: 'options.html', open_in_tab: true },
    // No other extension and no web page may message this one.
    externally_connectable: { ids: [] },
    action: { default_title: 'Inbox Pilot settings', default_icon: icons },
    icons,
  };
  if (publicKey) manifest.key = publicKey;
  return manifest;
}

function loadConfig() {
  const file = join(root, 'config', 'extension.config.json');
  const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const googleClientId = (process.env.GMC_GOOGLE_CLIENT_ID ?? fromFile.googleClientId ?? '').trim();
  if (googleClientId && !/^\d{6,20}-[a-z0-9]{20,40}\.apps\.googleusercontent\.com$/.test(googleClientId)) {
    throw new Error('Google client ID has an unexpected format (it ends with .apps.googleusercontent.com). It must be the client ID, never the client secret.');
  }
  return { googleClientId };
}

async function main() {
  const config = loadConfig();
  // A store build never carries a client ID, even when one is configured for personal builds: every user brings their own.
  if (store) config.googleClientId = '';
  const keyFile = join(root, 'config', 'extension-public-key.txt');
  const publicKey = existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '';
  const runtimeConfig = {
    authBase: 'https://auth.openai.com',
    chatgptBase: 'https://chatgpt.com/backend-api/codex',
    googleAuthBase: 'https://accounts.google.com',
    gmailBase: 'https://gmail.googleapis.com',
    calendarBase: 'https://www.googleapis.com/calendar/v3',
    clientVersion: CODEX_CLIENT_VERSION,
    version: pkg.version,
    googleClientId: config.googleClientId,
  };

  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(join(outdir, 'icons'), { recursive: true });

  const common = {
    bundle: true,
    target: 'chrome120',
    legalComments: 'none',
    sourcemap: false,
    minify: false,
    define: { __GMC_CONFIG__: JSON.stringify(runtimeConfig) },
    logLevel: 'warning',
  };
  await Promise.all([
    build({ ...common, entryPoints: [join(root, 'src/background/index.ts')], outfile: join(outdir, 'background.js'), format: 'esm' }),
    // Content scripts cannot be ES modules.
    build({ ...common, entryPoints: [join(root, 'src/content/index.ts')], outfile: join(outdir, 'content.js'), format: 'iife' }),
    build({ ...common, entryPoints: [join(root, 'src/options/options.ts')], outfile: join(outdir, 'options.js'), format: 'iife' }),
    build({ ...common, entryPoints: [join(root, 'src/offscreen/offscreen.ts')], outfile: join(outdir, 'offscreen.js'), format: 'esm' }),
  ]);

  copyFileSync(join(root, 'src/options/options.html'), join(outdir, 'options.html'));
  copyFileSync(join(root, 'src/options/options.css'), join(outdir, 'options.css'));
  copyFileSync(join(root, 'src/options/force-motion.js'), join(outdir, 'force-motion.js'));
  copyFileSync(join(root, 'src/offscreen/offscreen.html'), join(outdir, 'offscreen.html'));
  for (const size of [16, 32, 48, 128]) writeFileSync(join(outdir, 'icons', `icon${size}.png`), renderIcon(size));
  writeFileSync(join(outdir, 'manifest.json'), JSON.stringify(createManifest({ publicKey: store ? '' : publicKey }), null, 2) + '\n');

  if (store) {
    mkdirSync(join(root, 'release'), { recursive: true });
    const zip = join(root, 'release', `inbox-pilot-${pkg.version}.zip`);
    const count = zipDirectory(outdir, zip);
    console.log(`Built Chrome Web Store package -> ${zip} (${count} files; no "key": the store assigns the ID)`);
    return;
  }
  const id = publicKey ? ` [extension ID ${extensionIdFor(publicKey)}]` : '';
  console.log(`Built extension -> ${outdir}${id}${config.googleClientId ? ' (with a built-in Google client ID)' : ''}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
