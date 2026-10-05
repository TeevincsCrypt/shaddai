/**
 * Part 2: a screen-recorded walkthrough of the app, driven by Playwright.
 *
 * Starts the server in demo mode (the fixture chain, labelled as demo in the UI),
 * walks Portfolio → Ledger → dividend answer → Spread → thin-wrapper Buy →
 * Collateral → CSV → MCP, and records it to demo/out/part2-walkthrough.mp4 with
 * a caption bar, a visible cursor, a subtitle track and a timed voice-over script.
 *
 *   npm run build && FFMPEG=/path/to/ffmpeg npm run demo:walkthrough
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Locator, type Page } from 'playwright-core';
import { ScreenRecorder, toScript, toSrt } from './lib/recorder.js';
import { synthesize } from './lib/voice.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(here, 'out');
mkdirSync(out, { recursive: true });
const PORT = Number(process.env.DEMO_PORT ?? 8795);
const BASE = `http://localhost:${PORT}`;
const STEPS = 8;

if (!existsSync(join(root, 'dist', 'web', 'index.html'))) {
  throw new Error('Build the web app first: npm run build');
}

// ---------------------------------------------------------------------------
// Server

const server = spawn(
  process.execPath,
  [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/server/main.ts', '--demo'],
  {
    cwd: root,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
const stopServer = () => server.kill('SIGTERM');
process.on('exit', stopServer);
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${BASE}/api/health`)).ok) break;
  } catch {
    /* not up yet */
  }
  if (i > 80) throw new Error('demo server did not start');
  await new Promise((r) => setTimeout(r, 250));
}

// ---------------------------------------------------------------------------
// Overlay: caption bar, cursor, title cards, panels. Installed on every page load.

const OVERLAY = () => {
  const css = `
    #demo-cursor{position:fixed;left:0;top:0;width:30px;height:30px;z-index:2147483647;pointer-events:none;
      transform:translate(720px,420px);transition:transform .75s cubic-bezier(.3,.7,.2,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
    .demo-ripple{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;z-index:2147483646;
      pointer-events:none;border:3px solid #1570e6;animation:demo-ripple .6s ease-out forwards}
    @keyframes demo-ripple{from{transform:scale(.3);opacity:.9}to{transform:scale(1.6);opacity:0}}
    #demo-caption{position:fixed;left:50%;bottom:28px;transform:translate(-50%,12px);opacity:0;z-index:2147483645;
      max-width:1080px;width:max-content;padding:14px 22px 16px;border-radius:18px;background:rgba(15,23,32,.92);color:#fff;
      font:500 21px/1.42 'Figtree Variable',Figtree,system-ui,sans-serif;box-shadow:0 18px 40px -12px rgba(0,0,0,.5);
      transition:opacity .35s ease,transform .35s ease;pointer-events:none}
    #demo-caption.on{opacity:1;transform:translate(-50%,0)}
    #demo-caption .step{display:block;font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#7cc4ff;margin-bottom:4px}
    #demo-title{position:fixed;inset:0;z-index:2147483644;display:grid;place-items:center;text-align:center;
      background-color:#eef0f3;background-image:radial-gradient(#cfd5dd 1.1px,transparent 1.4px);background-size:18px 18px;
      opacity:0;pointer-events:none;transition:opacity .5s ease;font-family:'Figtree Variable',Figtree,system-ui,sans-serif;color:#0f1720}
    #demo-title.on{opacity:1}
    #demo-title .t{display:grid;gap:22px;justify-items:center}
    #demo-title img{width:84px;height:84px;padding:14px;border-radius:24px;background:#fff;box-shadow:0 14px 34px -10px rgba(16,24,40,.25)}
    #demo-title h1{font-size:64px;line-height:1.05;letter-spacing:-.04em;font-weight:650}
    #demo-title h1 span{display:block}#demo-title h1 .l2{color:#9aa1ac}
    #demo-title p{font-size:22px;color:#475467;max-width:820px;line-height:1.45}
    #demo-title .k{font-size:15px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#1570e6}
    #demo-panel{position:fixed;right:40px;top:96px;width:900px;z-index:2147483643;opacity:0;transform:translateY(10px);
      transition:opacity .4s ease,transform .4s ease;pointer-events:none;border-radius:20px;overflow:hidden;
      box-shadow:0 24px 60px -16px rgba(16,24,40,.45);background:#0f1720;color:#e6edf3}
    #demo-panel.on{opacity:1;transform:none}
    #demo-panel .h{padding:12px 18px;background:#1b2531;font:600 14px/1.4 'Figtree Variable',Figtree,sans-serif;color:#9fb3c8;letter-spacing:.04em}
    #demo-panel pre{margin:0;padding:16px 18px;font:400 14.5px/1.55 'IBM Plex Mono',ui-monospace,monospace;white-space:pre-wrap;word-break:break-word}
  `;
  const install = () => {
    if (document.getElementById('demo-cursor')) return;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    cursor.innerHTML =
      '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M4 2.5l15 9.2-6.6 1.4 3.9 7.3-2.7 1.4-3.9-7.3L4.8 19z" fill="#0f1720" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const caption = document.createElement('div');
    caption.id = 'demo-caption';
    const title = document.createElement('div');
    title.id = 'demo-title';
    const panel = document.createElement('div');
    panel.id = 'demo-panel';
    document.body.append(cursor, caption, title, panel);
  };
  const w = window as unknown as Record<string, unknown>;
  w.__demo = {
    install,
    caption(step: string, text: string) {
      const c = document.getElementById('demo-caption')!;
      c.classList.remove('on');
      setTimeout(() => {
        c.innerHTML = `<span class="step"></span><span class="tx"></span>`;
        c.querySelector('.step')!.textContent = step;
        c.querySelector('.tx')!.textContent = text;
        c.classList.add('on');
      }, 180);
    },
    hideCaption() {
      document.getElementById('demo-caption')!.classList.remove('on');
    },
    cursor(x: number, y: number) {
      document.getElementById('demo-cursor')!.style.transform = `translate(${x - 4}px,${y - 3}px)`;
    },
    ripple(x: number, y: number) {
      const r = document.createElement('div');
      r.className = 'demo-ripple';
      r.style.left = `${x}px`;
      r.style.top = `${y}px`;
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 700);
    },
    title(html: string | null) {
      const t = document.getElementById('demo-title')!;
      document.getElementById('demo-cursor')!.style.opacity = html === null ? '1' : '0';
      if (html === null) t.classList.remove('on');
      else {
        t.innerHTML = `<div class="t">${html}</div>`;
        t.classList.add('on');
      }
    },
    panel(head: string | null, body = '') {
      const p = document.getElementById('demo-panel')!;
      if (head === null) p.classList.remove('on');
      else {
        p.innerHTML = '<div class="h"></div><pre></pre>';
        p.querySelector('.h')!.textContent = head;
        p.querySelector('pre')!.textContent = body;
        p.classList.add('on');
      }
    },
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
};

type Demo = {
  install: () => void;
  caption: (step: string, text: string) => void;
  hideCaption: () => void;
  cursor: (x: number, y: number) => void;
  ripple: (x: number, y: number) => void;
  title: (html: string | null) => void;
  panel: (head: string | null, body?: string) => void;
};
const demo = (page: Page) => ({
  call: <K extends keyof Demo>(k: K, ...args: Parameters<Demo[K]>) =>
    page.evaluate(
      ([key, a]) => (window as unknown as { __demo: Record<string, (...x: unknown[]) => void> }).__demo[key]!(...a),
      [k, args] as [string, unknown[]],
    ),
});

// ---------------------------------------------------------------------------
// Recording

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({
  viewport: { width: 1440, height: 810 },
  deviceScaleFactor: 4 / 3,
  acceptDownloads: true,
});
await context.addInitScript(() => {
  try {
    localStorage.setItem('shaddai.theme', 'light');
  } catch {
    /* ignore */
  }
});
// tsx (esbuild) wraps named functions in __name(); give the page a no-op one.
await context.addInitScript({ content: `var __name = (f) => f; (${OVERLAY.toString()})();` });
const page = await context.newPage();
const d = demo(page);
const rec = new ScreenRecorder(page, join(out, '.frames-part2'));
const wait = (s: number) => page.waitForTimeout(s * 1000);

/** Every narrated line, keyed, so the voice can be synthesized before recording starts. */
const LINES = {
  intro: 'Part 2: a live walkthrough of Shaddai, recorded on the demo fixture.',
  start1: 'Paste any BSC address. Shaddai reads the raw balances, then the multiplier your wallet ignores.',
  start2: 'The landing reads the live multiplier index: the latest changes, and what 100 tokens are in shares.',
  port1: 'The demo address: NVDAB in the wallet, in Venus and lent on Lista, plus AAPLB, MSFTB, NVDAon and more.',
  port2: 'Raw is what balanceOf() returns: 10.000000. The multiplier is 1.0017×.',
  port3: 'So the address owns 10.017 NVIDIA share-equivalents. Shaddai always shows both numbers.',
  port4: 'XMPLB, a fictional demo stock, split 2-for-1: 30 raw tokens on Lista are 60.24 shares.',
  ledger1:
    'The ledger: every multiplier change, with no Transfer event behind any of them. Dividends, a split, one pending.',
  ledger2: '“Did I get the dividend?” One plain answer: when, the raw it applied to, old → new, and shares gained.',
  ledger3: 'When nothing touched the holder, it says so. It never invents a dividend.',
  ledger4:
    'Each row: raw held at the block before, old → new multiplier, Δ share-equivalents and an estimated USD value.',
  spread1:
    'Every NVIDIA wrapper, priced per share. NVDAB’s raw gap is +0.17%: that is the dividend factor. After the multiplier, 0.00%.',
  spread2:
    'NVDAon’s pool is thin, under $25k, so NVDAB is the tightest liquid wrapper. Outside US hours, rows say: quote, not a mispricing.',
  buy1: 'Size the buy in dollars of stock: $50 of NVIDIA.',
  buy2: 'The thin twin is refused before it is quoted: “NVDAon book is $14k, under the $25k floor.”',
  buy3: 'NVDAB is quoted in share-equivalents and preselected: the most stock for the money.',
  buy4: 'Step one is an exact-amount approve, decoded and dry-run before a wallet sees it. In the demo nothing is signed.',
  coll1: 'Lista counts raw tokens, not shares. MSFTB is posted as collateral, with a multiplier change scheduled.',
  coll2: 'Three numbers before the flip: the protocol holds 3 raw, 3.000000 shares today, 3.006060 after.',
  coll3: 'Plus what a share-priced oracle would do to the collateral value. Confirm the oracle before you borrow.',
  coll4: 'Nothing scheduled for NVDAB in Venus, so it says so, instead of showing a made-up preview.',
  csv1: 'One click exports the ledger to CSV, the rows a tax tool reading only transfers would never see.',
  mcp1: 'Agents get the same answers as MCP tools. This is sharetrue.dividend, called on the running server.',
  outro: 'Your wallet counts tokens. Shaddai counts shares.',
} as const;
type Line = keyof typeof LINES;
const voices = synthesize(
  Object.entries(LINES).map(([id, text]) => ({ id, text })),
  join(out, '.voice'),
);

let step = 0;
let label = '';
/** Caption, subtitle and voice for one line; held until the line is said (and at least `min` seconds). */
async function say(key: Line, min = 3) {
  const text = LINES[key];
  const clip = voices.get(key);
  await d.call('caption', `${step} / ${STEPS} · ${label}`, text);
  await wait(0.25);
  const speak = clip?.seconds ?? text.split(/\s+/).length / 2.6;
  rec.voice(clip);
  rec.cue(text, speak);
  await wait(Math.max(min, speak + 0.6));
}
/** New chapter: clear the last caption so it does not ride along into the next screen. */
async function chapter(name: string) {
  await d.call('hideCaption');
  step += 1;
  label = name;
}
async function centre(l: Locator) {
  const b = await l.boundingBox();
  if (!b) throw new Error('element not visible');
  return { x: b.x + Math.min(b.width / 2, 160), y: b.y + b.height / 2 };
}
async function point(l: Locator, settle = 0.9) {
  await l.scrollIntoViewIfNeeded();
  const c = await centre(l);
  await d.call('cursor', c.x, c.y);
  await wait(settle);
}
async function click(l: Locator) {
  await point(l);
  const c = await centre(l);
  await d.call('ripple', c.x, c.y);
  rec.sfx('click');
  await l.click();
  await wait(0.5);
}
async function type(l: Locator, text: string) {
  for (const ch of text) {
    rec.sfx('key');
    await l.press(ch);
    await wait(0.17);
  }
}
async function panel(head: string | null, body = '') {
  if (head !== null) rec.sfx('pop');
  await d.call('panel', head, body);
}
async function title(html: string | null) {
  rec.sfx(html === null ? 'whoosh' : 'chime');
  await d.call('title', html);
}
async function scrollTo(l: Locator, block: 'start' | 'center' = 'center') {
  await l.evaluate((el, b) => el.scrollIntoView({ behavior: 'smooth', block: b }), block);
  await wait(1.1);
}
async function scrollTop() {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await wait(0.9);
}
const tab = (name: string) => page.locator('nav.nav button', { hasText: name }).first();

/** A few CSV columns as an aligned text table (handles quoted fields). */
function csvTable(csv: string, cols: string[], maxRows: number): string {
  const parse = (line: string) => {
    const out: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (q && ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = !q;
      else if (ch === ',' && !q) {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const [head, ...rows] = csv.trim().split('\n').map(parse);
  const idx = cols.map((c) => head!.indexOf(c));
  const cells = [
    cols,
    ...rows.slice(0, maxRows).map((r) => idx.map((i, j) => (j === 0 ? (r[i] ?? '').slice(0, 10) : (r[i] ?? '')))),
  ];
  const width = cols.map((_, j) => Math.max(...cells.map((r) => r[j]!.length)));
  return cells.map((r) => r.map((c, j) => c.padEnd(width[j]!)).join('  ')).join('\n');
}

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await d.call(
  'title',
  `<span class="k">Part 2 · Live walkthrough</span>
  <img src="/favicon.svg" alt=""><h1><span>Your wallet counts tokens.</span><span class="l2">Shaddai counts shares.</span></h1>
  <p>Recorded on Shaddai's demo fixture: a simulated BSC chain with illustrative numbers, labelled as demo in the app. Same code paths as mainnet.</p>`,
);
await wait(0.8);
await rec.start();
rec.sfx('rise');
await wait(0.8);
rec.sfx('chime');
await say('intro', 3.5);
await title(null);
await wait(0.8);

// 1 · Landing
await chapter('Start');
await point(page.locator('.hero-title'), 0.6);
await say('start1');
await point(page.locator('.f-feed'), 0.4);
await say('start2');
await click(page.locator('.top-actions .btn.primary'));
await page.locator('table.stmt').first().waitFor();
await wait(1);

// 2 · Portfolio
await chapter('Portfolio');
await say('port1');
const gotIt = page.locator('.explainer-card button');
if (await gotIt.isVisible()) await click(gotIt);
const nvdab = page.locator('table.stmt tbody tr', { hasText: 'NVDAB' }).first();
await scrollTo(nvdab);
await point(nvdab.locator('td').nth(1));
await say('port2');
await point(nvdab.locator('td').nth(3));
await say('port3');
const xmpl = page.locator('table.stmt tbody tr', { hasText: 'Lista' }).filter({ hasText: 'XMPLB' }).first();
await scrollTo(xmpl);
await point(xmpl);
await say('port4');

// 3 · Ledger + dividend
await chapter('Ledger');
await scrollTop();
await click(tab('Ledger'));
await page.locator('.dividend-check').waitFor();
await say('ledger1');
const select = page.locator('.dividend-ask select');
await point(select);
await select.selectOption('AAPL');
await wait(0.4);
await click(page.locator('.dividend-ask button'));
await page.locator('.dividend-answer').waitFor();
rec.sfx('pop');
await say('ledger2', 7);
await select.selectOption('TSLA');
await click(page.locator('.dividend-ask button'));
await page.locator('.dividend-answer', { hasText: 'TSLAB' }).waitFor();
rec.sfx('pop');
await say('ledger3');
const firstRow = page.locator('table.stmt tbody tr').first();
await scrollTo(firstRow, 'start');
await say('ledger4');

// 4 · Spread
await chapter('Spread');
await scrollTop();
await click(tab('Spread'));
await page.locator('table.stmt tbody tr').first().waitFor();
await wait(0.6);
const spreadB = page.locator('table.stmt tbody tr', { hasText: 'NVDAB' }).first();
await point(spreadB.locator('td').nth(5));
await say('spread1', 6);
const spreadOn = page.locator('table.stmt tbody tr', { hasText: 'NVDAon' }).first();
await point(spreadOn.locator('.chip').first());
await say('spread2', 6);

// 5 · Buy
await chapter('Buy');
await scrollTop();
await click(tab('Buy'));
const usd = page.locator('.buy-form input').first();
await usd.waitFor();
await click(usd);
await usd.fill('');
await type(usd, '50');
await say('buy1');
await click(page.locator('.buy-form button.btn.primary'));
await page.locator('table.stmt tbody tr', { hasText: 'NVDAon' }).waitFor();
rec.sfx('pop');
await wait(0.6);
const refused = page.locator('table.stmt tbody tr', { hasText: 'NVDAon' }).first();
await point(refused.locator('.notes li').first());
await say('buy2', 5);
const chosen = page.locator('table.stmt tbody tr', { hasText: 'NVDAB' }).first();
await point(chosen.locator('td').nth(3));
await say('buy3');
const approve = page.getByRole('button', { name: 'Preview the approve' });
await scrollTo(approve);
await click(approve);
rec.sfx('pop');
await wait(1);
await page.mouse.wheel(0, 360);
await wait(0.8);
await say('buy4', 5);

// 6 · Collateral
await chapter('Collateral');
await scrollTop();
await click(tab('Collateral'));
const msft = page.locator('article.warn', { hasText: 'MSFTB · Lista' }).first();
await msft.waitFor();
await scrollTo(msft, 'start');
await point(msft.locator('.sev'));
await say('coll1');
await scrollTo(msft.locator('.flip'));
await point(msft.locator('.flip-figs > div').nth(2));
await say('coll2', 5);
await point(msft.locator('.flip p'));
await say('coll3');
const venus = page.locator('article.warn', { hasText: 'NVDAB · Venus' }).first();
await scrollTo(venus.locator('.flip'));
await point(venus.locator('.flip p'));
await say('coll4');

// 7 · CSV
await chapter('CSV');
await scrollTop();
await click(tab('Ledger'));
const csvLink = page.getByRole('link', { name: 'Download CSV' });
await csvLink.waitFor();
const download = page.waitForEvent('download');
await click(csvLink);
const file = await download;
const csv = await page.evaluate(async (u) => (await fetch(u)).text(), (await csvLink.getAttribute('href'))!);
await file.cancel().catch(() => undefined);
const table = csvTable(csv, ['date', 'symbol', 'raw_at_event', 'old_mult', 'new_mult', 'delta_share_eq', 'est_usd'], 7);
await panel(`shaddai-ledger.csv · ${csv.trim().split('\n').length - 1} rows (key columns)`, table);
await say('csv1', 5);
await d.call('panel', null);

// 8 · MCP
await chapter('Agents');
const mcp = await page.evaluate(async () => {
  const r = await fetch('/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'sharetrue_dividend', arguments: { address: 'demo', ticker: 'AAPL' } },
    }),
  });
  const body = (await r.json()) as { result?: { content?: { text?: string }[] } };
  return body.result?.content?.[0]?.text ?? JSON.stringify(body).slice(0, 400);
});
await panel(
  'POST /api/mcp · tools/call sharetrue_dividend {address: "demo", ticker: "AAPL"}',
  mcp.split('\n').slice(0, 4).join('\n'),
);
await say('mcp1', 7);
await d.call('panel', null);
await d.call('hideCaption');
await wait(0.4);

await title(
  `<img src="/favicon.svg" alt=""><h1><span>Your wallet counts tokens.</span><span class="l2">Shaddai counts shares.</span></h1>
  <p>Spot only · BSC mainnet · your wallet signs · github.com/TeevincsCrypt/shaddai</p>`,
);
await wait(0.6);
const outro = voices.get('outro');
rec.voice(outro);
rec.cue(LINES.outro, outro?.seconds ?? 3);
await wait(Math.max(4.5, (outro?.seconds ?? 3) + 1.5));
await rec.stop();
await browser.close();
stopServer();

const srt = join(out, 'part2-walkthrough.srt');
writeFileSync(srt, toSrt(rec.cues));
writeFileSync(join(out, 'part2-voiceover.md'), toScript('Part 2 · Walkthrough — voice-over', rec.cues));
const video = join(out, '.part2-video.mp4');
rec.encode(video, { srt });
const audio = rec.soundtrack(join(out, '.part2-audio.wav'), 'walkthrough');
rec.mux(video, audio, join(out, 'part2-walkthrough.mp4'));
console.log(`part2-walkthrough.mp4: ${rec.duration.toFixed(1)} s`);
process.exit(0);
