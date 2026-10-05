/**
 * Screen recorder for the demo videos: Chrome DevTools screencast frames (JPEG,
 * timestamped) written to disk, then encoded with ffmpeg at the frames' real
 * timing, resampled to 30 fps H.264. Sharper than Playwright's built-in VP8
 * recording, and the timing is wall-clock, so CSS animations play at speed.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CDPSession, Page } from 'playwright-core';
import type { VoiceClip } from './voice.js';

export const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const AUDIO_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'audio', 'soundtrack.py');

export type Sfx = 'whoosh' | 'rise' | 'click' | 'key' | 'pop' | 'chime';

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export class ScreenRecorder {
  private frames: { file: string; t: number }[] = [];
  private cdp: CDPSession | null = null;
  private t0 = 0;
  private tEnd = 0;
  private n = 0;
  /** Wall-clock times (seconds); converted to video time once the first frame is known. */
  private cueLog: { wall: number; seconds: number; text: string }[] = [];
  private sfxLog: { wall: number; kind: Sfx }[] = [];
  private voiceLog: { wall: number; file: string }[] = [];

  constructor(
    private readonly page: Page,
    private readonly dir: string,
    private readonly size = { width: 1920, height: 1080 },
  ) {}

  /** Seconds since recording started. */
  now(): number {
    return Date.now() / 1000 - this.t0;
  }

  async start() {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
      const file = join(this.dir, `f${String(this.n++).padStart(6, '0')}.jpg`);
      writeFileSync(file, Buffer.from(f.data, 'base64'));
      this.frames.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 });
      void this.cdp?.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
    });
    this.t0 = Date.now() / 1000;
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 92,
      maxWidth: this.size.width,
      maxHeight: this.size.height,
      everyNthFrame: 1,
    });
  }

  /** A subtitle line from now for `seconds`. */
  cue(text: string, seconds: number) {
    this.cueLog.push({ wall: Date.now() / 1000, seconds, text });
  }

  /** A sound effect at this moment. */
  sfx(kind: Sfx) {
    this.sfxLog.push({ wall: Date.now() / 1000, kind });
  }

  /** A voice-over clip starting now. */
  voice(clip: VoiceClip | undefined) {
    if (clip) this.voiceLog.push({ wall: Date.now() / 1000, file: clip.file });
  }

  private get origin() {
    return this.frames[0]?.t ?? this.t0;
  }

  /** Subtitle cues on the video's timeline. */
  get cues(): Cue[] {
    return this.cueLog.map((c) => ({
      start: c.wall - this.origin,
      end: c.wall - this.origin + c.seconds,
      text: c.text,
    }));
  }

  get duration() {
    return this.tEnd - this.origin;
  }

  /** Renders music, sound effects and voice for the recorded timeline (demo/audio/soundtrack.py). */
  soundtrack(out: string, style: 'pitch' | 'walkthrough'): string {
    const job = join(this.dir, 'timeline.json');
    writeFileSync(
      job,
      JSON.stringify({
        duration: this.duration,
        style,
        voice: this.voiceLog.map((v) => ({ file: v.file, start: Math.max(0, v.wall - this.origin) })),
        sfx: this.sfxLog.map((e) => ({ kind: e.kind, t: Math.max(0, e.wall - this.origin) })),
      }),
    );
    const r = spawnSync(process.env.PYTHON ?? 'python3', [AUDIO_SCRIPT, job, out], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('soundtrack failed: pip install numpy soundfile');
    return out;
  }

  /** Puts the soundtrack under the video (loudness-normalized to -16 LUFS), keeping the subtitle track. */
  mux(video: string, audio: string, out: string) {
    const args = ['-y', '-loglevel', 'error', '-i', video, '-i', audio, '-map', '0:v', '-map', '0:s?', '-map', '1:a'];
    args.push('-c:v', 'copy', '-c:s', 'copy', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k');
    args.push('-ar', '48000', '-metadata:s:a:0', 'language=eng', '-movflags', '+faststart', out);
    const r = spawnSync(FFMPEG, args, { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`ffmpeg mux failed (${r.status})`);
  }

  async stop() {
    this.tEnd = Date.now() / 1000;
    await this.cdp?.send('Page.stopScreencast').catch(() => undefined);
    // Let in-flight frames land.
    await new Promise((r) => setTimeout(r, 300));
  }

  /** Encodes the frames (and optional SRT, as a soft subtitle track) into an MP4. */
  encode(out: string, opts: { srt?: string; fadeSeconds?: number } = {}) {
    if (!this.frames.length) throw new Error('no frames captured');
    const lines = ['ffconcat version 1.0'];
    this.frames.forEach((f, i) => {
      const next = this.frames[i + 1]?.t ?? this.tEnd;
      lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
    });
    lines.push(`file '${this.frames.at(-1)!.file}'`);
    const list = join(this.dir, 'frames.txt');
    writeFileSync(list, lines.join('\n'));
    const total = this.tEnd - this.frames[0]!.t;
    const fade = opts.fadeSeconds ?? 0.6;
    const { width, height } = this.size;
    const vf = [
      'fps=30',
      `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0xeef0f3`,
      `fade=t=in:st=0:d=${fade}`,
      `fade=t=out:st=${Math.max(0, total - fade).toFixed(2)}:d=${fade}`,
      'format=yuv420p',
    ].join(',');
    const args = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list];
    if (opts.srt) args.push('-i', opts.srt);
    args.push('-vf', vf, '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart');
    if (opts.srt) args.push('-map', '0:v', '-map', '1:s', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng');
    args.push(out);
    const r = spawnSync(FFMPEG, args, { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status}). Set FFMPEG to an ffmpeg with libx264.`);
    return total;
  }
}

const ts = (s: number) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)},${pad(ms % 1000, 3)}`;
};

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join('\n');
}

/** Voice-over script: each line with its start time, to read over the video. */
export function toScript(title: string, cues: Cue[]): string {
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  return [`# ${title}`, '', ...cues.map((c) => `[${mmss(c.start)}–${mmss(c.end)}] ${c.text}`), ''].join('\n');
}
