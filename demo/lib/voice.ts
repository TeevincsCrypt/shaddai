/**
 * Voice-over: subtitle text in, speakable text out, then Kokoro TTS (demo/tts/kokoro_tts.py).
 *
 * Subtitles keep digits and symbols; the voice gets words: "$295" → "295 dollars",
 * "NVDAB" → "N V D eh B" (spelled; "eh" makes the letter A, not the article),
 * "→" → "to", "1.0017×" → "1.0017", "10.000000" → "10".
 *
 * Needs Python with kokoro-onnx and soundfile, and the model files in demo/.models
 * (or KOKORO_MODEL / KOKORO_VOICES). DEMO_VOICE=0 skips the voice entirely.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const VOICE = process.env.KOKORO_VOICE ?? 'af_heart';
export const SPEED = Number(process.env.KOKORO_SPEED ?? 1.0);

const spell = (w: string) => [...w].map((c) => (c === 'A' ? 'eh' : c)).join(' ');

/** Speakable text for TTS. */
export function spoken(text: string): string {
  let s = text;
  // Wrapper symbols: NVDAB, AAPLB, NVDAon, GOOGLon, XMPLB… spelled out.
  s = s.replace(
    /\b([A-Z]{3,5})(B|on)\b/g,
    (_, base: string, suf: string) => `${spell(base)} ${suf === 'B' ? 'B' : 'on'}`,
  );
  s = s
    .replace(/\bUSDT\b/g, 'U S D T')
    .replace(/\bUSD1\b/g, 'U S D 1')
    .replace(/\bBEP-677\b/g, 'B E P 6 7 7')
    .replace(/\bERC-8056\b/g, 'E R C 8 0 5 6')
    .replace(/balanceOf\(\)/g, 'balance of')
    .replace(/\buiMultiplier\b/g, 'U I multiplier')
    .replace(/\bsValue\b/g, 'S value')
    .replace(/sharetrue\./g, 'share true dot ')
    .replace(/\bsharetrue\b/gi, 'share true')
    .replace(/→/g, ' to ')
    .replace(/Δ/g, 'change in ')
    .replace(/[“”"]/g, '');
  // Money: $14k, $3.8 million, $1.38, $295.
  s = s.replace(/\$(\d+(?:,\d{3})*(?:\.\d+)?)(?:\s*(k|million)\b)?/g, (_, n: string, unit?: string) => {
    if (unit === 'k') return `${n} thousand dollars`;
    if (unit === 'million') return `${n} million dollars`;
    const [whole = '0', cents] = n.split('.');
    const w = whole.replace(/,/g, '');
    const dollars = `${w} ${w === '1' ? 'dollar' : 'dollars'}`;
    return cents && /[1-9]/.test(cents) ? `${dollars} ${cents.padEnd(2, '0').slice(0, 2)}` : dollars;
  });
  // Numbers: drop trailing zeros (10.000000 → 10, 3.006060 → 3.00606), the × sign, and a leading +.
  s = s.replace(/(\d+)\.(\d*?)0+\b/g, (_, w: string, f: string) => (f ? `${w}.${f}` : w));
  s = s.replace(/(\d)×/g, '$1').replace(/\+(\d)/g, 'plus $1');
  return s.replace(/\s+/g, ' ').trim();
}

export interface VoiceClip {
  file: string;
  seconds: number;
}

/** Synthesizes every line (cached by text, voice and speed) and returns each clip with its length. */
export function synthesize(lines: { id: string; text: string }[], dir: string): Map<string, VoiceClip> {
  const out = new Map<string, VoiceClip>();
  if (process.env.DEMO_VOICE === '0') return out;
  mkdirSync(dir, { recursive: true });
  const root = join(dir, '..', '..');
  const model = process.env.KOKORO_MODEL ?? join(root, '.models', 'kokoro-v1.0.onnx');
  const voices = process.env.KOKORO_VOICES ?? join(root, '.models', 'voices-v1.0.bin');
  if (!existsSync(model) || !existsSync(voices)) {
    throw new Error(
      `Kokoro model files not found (${model}). Download kokoro-v1.0.onnx and voices-v1.0.bin from ` +
        'github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0 into demo/.models, or set DEMO_VOICE=0.',
    );
  }
  const items = lines.map((l) => {
    const text = spoken(l.text);
    const hash = createHash('sha1').update(`${VOICE}|${SPEED}|${text}`).digest('hex').slice(0, 16);
    return { id: l.id, text, out: join(dir, `${hash}.wav`) };
  });
  const r = spawnSync(process.env.PYTHON ?? 'python3', [join(root, 'tts', 'kokoro_tts.py')], {
    input: JSON.stringify({ model, voices, voice: VOICE, speed: SPEED, items }),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
    maxBuffer: 1 << 24,
  });
  if (r.status !== 0) throw new Error('Kokoro TTS failed: pip install kokoro-onnx soundfile (or DEMO_VOICE=0).');
  const seconds = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as Record<string, number>;
  for (const it of items) out.set(it.id, { file: it.out, seconds: seconds[it.id]! });
  return out;
}
