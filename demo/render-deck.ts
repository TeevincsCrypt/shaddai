/**
 * Part 1: plays demo/deck/deck.html slide by slide and records it to
 * demo/out/part1-pitch.mp4, with a voice-over (Kokoro TTS), an original backing
 * track and transition sounds, plus the lines as a subtitle track
 * (demo/out/part1-pitch.srt) and a timed script (demo/out/part1-voiceover.md).
 *
 *   FFMPEG=/path/to/ffmpeg npm run demo:deck
 *
 * Each slide stays up for the longer of its reading time (data-seconds) and its
 * spoken line plus a breath. The voice is synthesized before recording starts, so
 * the recording never waits on it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { ScreenRecorder, toScript, toSrt } from './lib/recorder.js';
import { synthesize } from './lib/voice.js';

type Deck = { slideMeta: { seconds: number; say: string }[]; show: (n: number) => void };

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(`${pathToFileURL(join(here, 'deck', 'deck.html')).href}?slide=-1`);
await page.evaluate(() => document.fonts.ready);
const meta = await page.evaluate(() => (window as unknown as Deck).slideMeta);

const id = (i: number) => `s${String(i + 1).padStart(2, '0')}`;
const voices = synthesize(
  meta.map((m, i) => ({ id: id(i), text: m.say })),
  join(out, '.voice'),
);

/** Slides that land with a chime: the solution and the close. */
const CHIME = new Set([5, meta.length - 1]);
const LEAD = 0.7; // entrance animation before the voice starts
const TAIL = 1.1; // breath after the line

const rec = new ScreenRecorder(page, join(out, '.frames-part1'));
await rec.start();
rec.sfx('rise');
await page.waitForTimeout(900);
for (const [i, m] of meta.entries()) {
  const clip = voices.get(id(i));
  const words = m.say.trim().split(/\s+/).length;
  const speak = clip?.seconds ?? words / 2.6;
  const seconds = Math.max(m.seconds, LEAD + speak + TAIL);
  await page.evaluate((n) => (window as unknown as Deck).show(n), i);
  if (i > 0) rec.sfx('whoosh');
  if (CHIME.has(i)) rec.sfx('chime');
  await page.waitForTimeout(LEAD * 1000);
  rec.voice(clip);
  rec.cue(m.say, speak);
  await page.waitForTimeout((seconds - LEAD) * 1000);
  process.stdout.write(`slide ${i + 1}/${meta.length} (${seconds.toFixed(1)} s)\n`);
}
await rec.stop();
await browser.close();

const srt = join(out, 'part1-pitch.srt');
writeFileSync(srt, toSrt(rec.cues));
writeFileSync(join(out, 'part1-voiceover.md'), toScript('Part 1 · Pitch — voice-over', rec.cues));
const video = join(out, '.part1-video.mp4');
rec.encode(video, { srt });
const audio = rec.soundtrack(join(out, '.part1-audio.wav'), 'pitch');
rec.mux(video, audio, join(out, 'part1-pitch.mp4'));
console.log(`part1-pitch.mp4: ${rec.duration.toFixed(1)} s`);
