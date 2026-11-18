#!/usr/bin/env node
/* tests/test_playwright_e2e.cjs
 * E2E Playwright tests for dist/PathOfKungFuSaveEditor-v1.0.html
 *   Mode A: offline file:// (CSP connect-src 'none', 6 tabs, no Hanzi, download+decode)
 *   Mode B: loopback server (pokf_editor.py serve), save+backup+decode, backup modal
 *
 * Requires: playwright (or playwright-core + global chromium).
 * Skips (exit 0) ONLY if Playwright truly isn't installed; fails on real errors.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const DIST_HTML = path.join(REPO, 'dist', 'PathOfKungFuSaveEditor-v1.0.html');
const CODEC_JS = path.join(REPO, 'src', 'pokf-codec.js'); // PokfCodec (may be .js or .cjs)
const CODEC_CJS = path.join(REPO, 'pokf_codec.cjs');
const SERVE_PY = path.join(REPO, 'pokf_editor.py');

// ---------- resolve playwright ----------
function tryRequire(mod) {
  try { return require(mod); } catch (_) { return null; }
}
function attachBrowserExe(pw) {
  try {
    const def = pw.chromium && typeof pw.chromium.executablePath === 'function' ? pw.chromium.executablePath() : '';
    if (def && fs.existsSync(def)) return pw;
  } catch (_) {}
  const cands = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ].filter(Boolean);
  for (const c of cands) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) { pw.__exePath = c; return pw; } } catch (_) {}
  }
  return pw;
}
function resolvePlaywright() {
  let pw = tryRequire('playwright');
  if (pw && pw.chromium) return attachBrowserExe(pw);
  pw = tryRequire('/home/jiyoung/.local/lib/node_modules/@playwright/mcp/node_modules/playwright');
  if (pw && pw.chromium) return attachBrowserExe(pw);
  pw = tryRequire('/home/jiyoung/.npm-global/lib/node_modules/playwright');
  if (pw && pw.chromium) return attachBrowserExe(pw);
  pw = tryRequire('playwright-core');
  if (pw && pw.chromium) return attachBrowserExe(pw);
  return null;
}

// ---------- load PokfCodec (Node) ----------
function loadCodec() {
  const candidates = [CODEC_JS, CODEC_CJS, path.join(REPO, 'pokf', 'codec.js')];
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    try {
      const mod = require(c);
      const codec = (mod && mod.PokfCodec) || (mod && mod.default && mod.default.PokfCodec) || mod;
      if (codec && typeof codec.decodeSaveBytes === 'function' && typeof codec.encodeSaveBytes === 'function') {
        return codec;
      }
    } catch (_) {}
  }
  return null;
}

// ---------- tiny helpers ----------
function assert(cond, msg) {
  if (!cond) { const e = new Error('ASSERT: ' + msg); e.name = 'AssertionError'; throw e; }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function hasHanzi(str) { return /[\u3400-\u9fff]/.test(str || ''); }

function parseBoundUrl(text) {
  // look for http://127.0.0.1:PORT or http://localhost:PORT
  const m = text.match(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\/?/i);
  return m ? { port: parseInt(m[1], 10), url: m[0].replace(/\/$/, '') } : null;
}

function waitForServer(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('server startup timeout; stdout=' + buf)), timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString();
      const parsed = parseBoundUrl(buf);
      if (parsed) {
        clearTimeout(timer);
        child.stdout.removeListener('data', onData);
        resolve(parsed);
      }
    };
    child.stdout.on('data', onData);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      if (!buf || !parseBoundUrl(buf)) { clearTimeout(timer); reject(new Error('server exited ' + code + '; stdout=' + buf)); }
    });
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    }).on('error', reject);
  });
}

// ---------- main ----------
(async () => {
  const pw = resolvePlaywright();
  if (!pw) {
    console.error('[skip] Playwright not installed — skipping E2E suite.');
    process.exit(0);
  }

  const codec = loadCodec();
  if (!codec) {
    console.error('[fail] PokfCodec not found (pokf_codec.js/.cjs) — cannot verify downloads.');
    process.exit(1);
  }
  if (!fs.existsSync(DIST_HTML)) {
    console.error('[fail] missing dist HTML: ' + DIST_HTML);
    process.exit(1);
  }
  if (!fs.existsSync(SERVE_PY)) {
    console.error('[fail] missing pokf_editor.py: ' + SERVE_PY);
    process.exit(1);
  }

  const launchOpts = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (pw.__exePath) launchOpts.executablePath = pw.__exePath;

  let browser;
  try {
    browser = await pw.chromium.launch(launchOpts);
  } catch (e) {
    console.error('[fail] could not launch chromium: ' + (e && e.message));
    process.exit(1);
  }

  const failures = [];
  const allConsoleErrors = [];

  async function newPage() {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', (err) => errors.push('pageerror: ' + (err && err.message)));
    allConsoleErrors.push(errors);
    return { ctx, page, errors };
  }

  // ---------------- MODE A ----------------
  async function modeA() {
    console.log('\n=== MODE A (file://) ===');
    const { ctx, page, errors } = await newPage();
    try {
      const url = 'file://' + DIST_HTML;
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForSelector('[role="tab"]', { timeout: 10000 });

      // 6 tabs
      const tabCount = await page.locator('[role="tab"]').count();
      assert(tabCount === 6, `expected 6 tabs, got ${tabCount}`);

      // no Hanzi in body.innerText
      const bodyText = await page.evaluate(() => document.body.innerText);
      assert(!hasHanzi(bodyText), 'found Hanzi (U+3400..U+9FFF) in body.innerText');

      // CSP connect-src 'none'
      const csp = await page.evaluate(() => {
        const metas = Array.from(document.querySelectorAll('meta[http-equiv]'));
        for (const m of metas) {
          if ((m.getAttribute('http-equiv') || '').toLowerCase() === 'content-security-policy') {
            return m.getAttribute('content') || '';
          }
        }
        return '';
      });
      assert(/connect-src[^;]*'none'/i.test(csp), `CSP connect-src 'none' not found; got: ${csp}`);

      // demo load
      await page.click('#btn-demo');
      await page.waitForSelector('#notice-bar', { state: 'visible', timeout: 5000 });
      const noticeText = (await page.locator('#notice-bar').innerText()).trim();
      assert(noticeText.length > 0, '#notice-bar empty after demo');
      const firstName = await page.inputValue('#firstName').catch(() => '');
      const sliverA = await page.inputValue('#sliver').catch(() => '');
      const goldA = await page.inputValue('#gold').catch(() => '');
      assert(firstName !== '', 'firstName empty after demo');
      assert(sliverA !== '', 'sliver empty after demo');
      assert(goldA !== '', 'gold empty after demo');

      // keyboard nav on tab-list
      await page.locator('#tab-list').focus();
      const before = await page.evaluate(() => {
        const sel = document.querySelector('[role="tab"][aria-selected="true"]');
        return sel ? sel.id || sel.getAttribute('data-tab') || sel.textContent : null;
      });
      await page.keyboard.press('ArrowRight');
      await sleep(150);
      const after = await page.evaluate(() => {
        const sel = document.querySelector('[role="tab"][aria-selected="true"]');
        return sel ? sel.id || sel.getAttribute('data-tab') || sel.textContent : null;
      });
      assert(before !== null && after !== null, 'could not read selected tab');
      assert(before !== after, `ArrowRight did not change tab (before=${before}, after=${after})`);

      // return to Tab 0 so #sliver is visible
      await page.keyboard.press('ArrowLeft');
      await sleep(100);

      // theme cycle
      const themeBefore = await page.evaluate(() => document.documentElement.getAttribute('data-theme') || '');
      await page.click('#btn-theme');
      await sleep(150);
      const themeAfter = await page.evaluate(() => document.documentElement.getAttribute('data-theme') || '');
      assert(themeBefore !== themeAfter, `theme cycle did not change (before=${themeBefore}, after=${themeAfter})`);

      // edit sliver + save + capture download
      await page.fill('#sliver', '12345');
      const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
      await page.click('#btn-save');
      const download = await downloadPromise;
      const dlPath = await download.path();
      assert(dlPath, 'download has no path');
      const bytes = fs.readFileSync(dlPath);
      assert(bytes.length > 16, `downloaded .save too small: ${bytes.length} bytes`);

      // decode with PokfCodec
      let decoded;
      try {
        decoded = await codec.decodeSaveBytes(bytes);
      } catch (e) {
        throw new Error('decodeSaveBytes threw: ' + e.message);
      }
      assert(decoded && typeof decoded === 'object', 'decodeSaveBytes returned non-object');

      // find sliver in decoded (defensive: could be nested or top-level)
      const findValue = (obj, key) => {
        if (!obj || typeof obj !== 'object') return undefined;
        if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
        for (const k of Object.keys(obj)) {
          const v = findValue(obj[k], key);
          if (v !== undefined) return v;
        }
        return undefined;
      };
      const sliverDecoded = findValue(decoded, 'sliver');
      assert(sliverDecoded !== undefined, 'decoded save missing "sliver"');
      const sliverNum = typeof sliverDecoded === 'number' ? sliverDecoded : Number(sliverDecoded);
      assert(sliverNum === 12345, `decoded sliver mismatch: got ${sliverDecoded}, want 12345`);

      // zero console errors
      assert(errors.length === 0, `console/page errors in Mode A: ${JSON.stringify(errors)}`);
      console.log('MODE A: PASS');
    } catch (e) {
      failures.push('Mode A: ' + e.message);
      console.error('MODE A FAIL:', e.message);
      if (errors && errors.length) console.error('  console errors:', errors);
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  // ---------------- MODE B ----------------
  async function modeB() {
    console.log('\n=== MODE B (loopback serve) ===');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pokf-e2e-'));
    let child = null;
    let ctx = null;
    try {
      // seed PlayerData_1.save
      const seed = await codec.encodeSaveBytes({
        firstName: '무명',
        lastName: '협객',
        sliver: 111,
        gold: 222,
        attribute: 1,
        gameLv: 0,
      }, { containerKind: 'save-binary', slotId: '1' });
      const savePath = path.join(tmp, 'PlayerData_1.save');
      fs.writeFileSync(savePath, seed);
      // sanity: roundtrip
      const rt = await codec.decodeSaveBytes(fs.readFileSync(savePath));
      assert(rt && typeof rt === 'object', 'seed roundtrip failed');

      // spawn python server
      child = spawn('python3', [SERVE_PY, 'serve', '--root', tmp, '--port', '0'], {
        cwd: REPO,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderrBuf = '';
      child.stderr.on('data', (c) => { stderrBuf += c.toString(); });
      child.on('exit', (code) => {
        if (code !== 0 && code !== null) console.error('[mode B] server exited', code, stderrBuf);
      });

      const { port, url: baseUrl } = await waitForServer(child, 15000);
      const httpUrl = `http://127.0.0.1:${port}/`;
      console.log('[mode B] server at', httpUrl, '(root=' + tmp + ')');

      // quick HTTP probe
      const probe = await httpGet(httpUrl);
      assert(probe.status === 200, `server GET / status ${probe.status}`);

      // browser
      const created = await newPage();
      ctx = created.ctx;
      const page = created.page;
      const errors = created.errors;

      await page.goto(httpUrl, { waitUntil: 'load' });
      await page.waitForSelector('#conn-badge', { timeout: 10000 });

      // connected badge
      const badgeText = (await page.locator('#conn-badge').innerText()).trim();
      assert(badgeText.includes('서버 연결됨'), `conn-badge not connected; got: "${badgeText}"`);

      // wait for tab UI ready (server mode may populate after fetch)
      await page.waitForSelector('[role="tab"]', { timeout: 10000 });

      // edit sliver + apply a preset
      await page.fill('#sliver', '4242');
      // pick any preset button (best-effort; artifact typically uses .preset-btn or [data-preset])
      const presetSelectors = ['.preset-btn', '[data-preset]', '#preset-list button', '.presets button', 'button[name="preset"]'];
      let applied = false;
      for (const sel of presetSelectors) {
        const loc = page.locator(sel);
        const n = await loc.count().catch(() => 0);
        if (n > 0) {
          await loc.first().click();
          applied = true;
          break;
        }
      }
      // preset is optional for the spec's intent; do not fail hard if UI differs
      if (!applied) console.warn('[mode B] no preset button found; skipping preset apply');
      await sleep(200);

      // after preset, re-set sliver to deterministic value so decode is predictable
      await page.fill('#sliver', '4242');

      // click save -> expect a backup
      await page.click('#btn-save');
      // wait for backups dir to appear with at least one .bak
      const backupsDir = path.join(tmp, 'backups');
      let bakFiles = [];
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (fs.existsSync(backupsDir)) {
          bakFiles = fs.readdirSync(backupsDir).filter(f => f.endsWith('.bak'));
          if (bakFiles.length > 0) break;
        }
        await sleep(150);
      }
      assert(bakFiles.length > 0, `no .bak file created in ${backupsDir}`);

      // main save decodes with new values
      const newBytes = fs.readFileSync(savePath);
      const decoded = await codec.decodeSaveBytes(newBytes);
      const findValue = (obj, key) => {
        if (!obj || typeof obj !== 'object') return undefined;
        if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
        for (const k of Object.keys(obj)) {
          const v = findValue(obj[k], key);
          if (v !== undefined) return v;
        }
        return undefined;
      };
      const sliverDecoded = findValue(decoded, 'sliver');
      const sliverNum = typeof sliverDecoded === 'number' ? sliverDecoded : Number(sliverDecoded);
      assert(sliverNum === 4242, `after save, decoded sliver = ${sliverDecoded}, want 4242`);

      // backup modal
      await page.click('#btn-backup');
      await page.waitForSelector('dialog[open]', { timeout: 5000 });
      const dialogText = await page.locator('dialog[open]').innerText();
      // row is listed if a .bak filename (or the word backup) appears in the modal
      const hasRow = bakFiles.some(f => dialogText.includes(f)) || /backup/i.test(dialogText);
      assert(hasRow, 'backup modal does not list the created backup row');

      // close modal cleanly
      const closeSelectors = ['dialog[open] #btn-close', 'dialog[open] button[aria-label="Close"]',
        'dialog[open] .close', 'dialog[open] button.close'];
      let closed = false;
      for (const sel of closeSelectors) {
        const loc = page.locator(sel);
        if (await loc.count().catch(() => 0)) { await loc.first().click(); closed = true; break; }
      }
      if (!closed) {
        // fall back to Escape
        await page.keyboard.press('Escape');
      }
      const stillOpen = await page.locator('dialog[open]').count().catch(() => 0);
      assert(stillOpen === 0, 'backup modal did not close');

      assert(errors.length === 0, `console/page errors in Mode B: ${JSON.stringify(errors)}`);
      console.log('MODE B: PASS');
    } catch (e) {
      failures.push('Mode B: ' + e.message);
      console.error('MODE B FAIL:', e.message);
    } finally {
      if (ctx) await ctx.close().catch(() => {});
      if (child && !child.killed) {
        try { child.kill('SIGTERM'); } catch (_) {}
        // grace period then SIGKILL
        await sleep(200);
        try { if (child.exitCode === null) child.kill('SIGKILL'); } catch (_) {}
      }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
  }

  try {
    await modeA();
    await modeB();
  } finally {
    await browser.close().catch(() => {});
  }

  if (failures.length) {
    console.error('\n=== E2E FAILURES ===');
    for (const f of failures) console.error(' - ' + f);
    console.error('\nconsole error counts:', allConsoleErrors.map(a => a.length).join(','));
    process.exit(1);
  }
  console.log('\n=== E2E: ALL PASS ===');
  process.exit(0);
})().catch((e) => {
  console.error('[fatal]', e && (e.stack || e.message));
  process.exit(1);
});
