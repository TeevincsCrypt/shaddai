/**
 * Part 1: plays demo/deck/deck.html slide by slide and records it to
 * demo/out/part1-pitch.mp4, with the voice-over lines as a subtitle track
 * (demo/out/part1-pitch.srt) and a timed script (demo/out/part1-voiceover.md).
 *
 *   FFMPEG=/path/to/ffmpeg npm run demo:deck
 *
 * Each slide stays up for the longer of its reading time (data-seconds) and the
 * time its line takes to say at about 156 words a minute.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { ScreenRecorder, toScript, toSrt } from './lib/recorder.js';

type Deck = { slideMeta: { seconds: number; say: string }[]; show: (n: number) => void };

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(`${pathToFileURL(join(here, 'deck', 'deck.html')).href}?slide=-1`);
await page.evaluate(() => document.fonts.ready);
const meta = await page.evaluate(() => (window as unknown as Deck).slideMeta);

const rec = new ScreenRecorder(page, join(out, '.frames-part1'));
await rec.start();
await page.waitForTimeout(600);
for (const [i, m] of meta.entries()) {
  const words = m.say.trim().split(/\s+/).length;
  const seconds = Math.max(m.seconds, words / 2.6 + 1.5);
  await page.evaluate((n) => (window as unknown as Deck).show(n), i);
  rec.cue(m.say, seconds - 0.4);
  await page.waitForTimeout(seconds * 1000);
  process.stdout.write(`slide ${i + 1}/${meta.length} (${seconds.toFixed(1)} s)\n`);
}
await rec.stop();
await browser.close();

const srt = join(out, 'part1-pitch.srt');
writeFileSync(srt, toSrt(rec.cues));
writeFileSync(join(out, 'part1-voiceover.md'), toScript('Part 1 · Pitch — voice-over', rec.cues));
const total = rec.encode(join(out, 'part1-pitch.mp4'), { srt });
console.log(`part1-pitch.mp4: ${total.toFixed(1)} s`);
