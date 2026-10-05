"""
Soundtrack for the demo videos: an original backing track and UI sound effects, all
synthesized here from sine waves and noise (no samples, nothing to license), mixed with
the voice-over, the music ducked under the voice.

  python3 soundtrack.py timeline.json out.wav

timeline.json:
  {"duration": 170.2, "style": "pitch" | "walkthrough",
   "voice": [{"file": "a.wav", "start": 1.2}],
   "sfx": [{"kind": "whoosh" | "rise" | "click" | "key" | "pop" | "chime", "t": 3.4}]}

Needs numpy and soundfile.
"""
import json
import sys

import numpy as np
import soundfile as sf

SR = 48000


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def db(x):
    return 10 ** (x / 20)


# ---------------------------------------------------------------------------
# Music: a loop of four chords, two bars each, rendered once per layer and tiled.

STYLES = {
    # Warm, steady: Dmaj9 – Bm9 – Gmaj9 – A9sus4.
    "pitch": {
        "bpm": 92,
        "chords": [[50, 57, 61, 64, 66], [47, 54, 57, 61, 62], [43, 50, 54, 57, 59], [45, 52, 55, 59, 62]],
        "seed": 11,
    },
    # A touch brighter for the walkthrough: Fmaj9 – Dm9 – Bbmaj9 – C9sus4.
    "walkthrough": {
        "bpm": 100,
        "chords": [[53, 60, 64, 67, 69], [50, 57, 60, 64, 65], [46, 53, 57, 60, 62], [48, 55, 58, 62, 65]],
        "seed": 23,
    },
}


def additive(f, t, harmonics, rolloff, phase):
    sig = np.zeros_like(t)
    for h in range(1, harmonics + 1):
        if f * h > 9000:
            break
        sig += np.sin(2 * np.pi * f * h * t + phase * h) / h**rolloff
    return sig


def wrap_add(buf, start, x):
    """Adds x into a circular buffer starting at `start` (tails wrap to the loop start)."""
    n = buf.shape[0]
    idx = (start + np.arange(x.shape[0])) % n
    np.add.at(buf, idx, x)


def pad_loop(chords, bar, rng):
    seg = 2 * bar
    n = seg * len(chords)
    out = np.zeros((n, 2))
    tail = int(1.6 * SR)
    length = seg + tail
    t = np.arange(length) / SR
    env = np.ones(length)
    a = int(1.1 * SR)
    env[:a] = np.sin(np.linspace(0, np.pi / 2, a)) ** 2
    env[seg:] = np.cos(np.linspace(0, np.pi / 2, tail)) ** 2
    # Slow swell inside each chord keeps the bed moving.
    env *= 0.85 + 0.15 * np.sin(np.linspace(0, np.pi, length))
    for i, chord in enumerate(chords):
        x = np.zeros((length, 2))
        for m in chord:
            for det, pan in ((-6, 0.25), (0, 0.5), (6, 0.75)):
                s = additive(hz(m) * 2 ** (det / 1200), t, 7, 1.7, rng.uniform(0, 2 * np.pi))
                x[:, 0] += s * (1 - pan)
                x[:, 1] += s * pan
        wrap_add(out, i * seg, x * env[:, None])
    return out / np.max(np.abs(out))


def bass_loop(chords, bar, beat):
    seg = 2 * bar
    n = seg * len(chords)
    out = np.zeros(n)
    dur = int(1.4 * beat)
    t = np.arange(dur) / SR
    env = (1 - np.exp(-t / 0.006)) * np.exp(-t / 0.45)
    for i, chord in enumerate(chords):
        f = hz(chord[0] - 12 if chord[0] >= 48 else chord[0])
        tone = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(4 * np.pi * f * t) + 0.08 * np.sin(6 * np.pi * f * t)
        for b in (0, 2.5, 4, 6.5):  # two bars: beat 1 and the "and" of 3, each bar
            wrap_add(out, i * seg + int(b * beat), tone * env)
    out /= np.max(np.abs(out))
    return np.stack([out, out], axis=1)


def arp_loop(chords, bar, beat, rng):
    seg = 2 * bar
    n = seg * len(chords)
    out = np.zeros((n, 2))
    step = beat / 2
    dur = int(1.2 * SR)
    t = np.arange(dur) / SR
    pattern = [0, 2, 3, 4, 3, 2, 1, 2]
    for i, chord in enumerate(chords):
        tones = sorted(set(chord[1:])) + [chord[1] + 12]
        for k in range(16):  # sixteen eighth notes over two bars
            m = tones[pattern[k % 8] % len(tones)] + 12
            f = hz(m)
            vel = 0.55 + 0.45 * rng.random() * (1.0 if k % 2 == 0 else 0.7)
            env = (1 - np.exp(-t / 0.003)) * np.exp(-t / 0.30)
            tone = np.sin(2 * np.pi * f * t) + 0.22 * np.sin(4 * np.pi * f * t) * np.exp(-t / 0.08)
            tone += 0.06 * np.sin(6 * np.pi * f * t) * np.exp(-t / 0.05)
            pan = 0.35 if k % 2 == 0 else 0.65
            x = np.stack([tone * (1 - pan), tone * pan], axis=1) * (env * vel)[:, None]
            wrap_add(out, i * seg + int(k * step), x)
    # Dotted-eighth echo, three repeats, ping-ponged.
    d = int(0.75 * beat)
    echo = np.zeros_like(out)
    for r, g in enumerate((0.38, 0.2, 0.1), start=1):
        rolled = np.roll(out, r * d, axis=0) * g
        echo += rolled[:, ::-1] if r % 2 else rolled
    out = out + echo
    return out / np.max(np.abs(out))


def drum_loop(chords, bar, beat, rng):
    n = 2 * bar * len(chords)
    out = np.zeros((n, 2))
    beats = n // beat
    # Kick: 120 → 48 Hz drop.
    kt = np.arange(int(0.4 * SR)) / SR
    kf = 48 + 72 * np.exp(-kt / 0.035)
    kick = np.sin(2 * np.pi * np.cumsum(kf) / SR) * np.exp(-kt / 0.22)
    kick[:120] += np.linspace(0.6, 0, 120) * rng.standard_normal(120) * 0.3
    # Hat: high-passed noise tick.
    ht = np.arange(int(0.06 * SR)) / SR
    hn = rng.standard_normal(ht.size)
    hat = (hn - np.convolve(hn, np.ones(6) / 6, mode="same")) * np.exp(-ht / 0.012)
    # Soft clap: band-limited noise with a short body.
    ct = np.arange(int(0.25 * SR)) / SR
    cn = rng.standard_normal(ct.size)
    band = np.convolve(cn, np.ones(4) / 4, mode="same") - np.convolve(cn, np.ones(24) / 24, mode="same")
    clap = band * np.exp(-ct / 0.07) + 0.3 * np.sin(2 * np.pi * 185 * ct) * np.exp(-ct / 0.04)
    for b in range(beats):
        start = b * beat
        if b % 4 in (0, 2):
            wrap_add(out, start, np.stack([kick, kick], axis=1) * 0.9)
        if b % 4 in (1, 3):
            wrap_add(out, start, np.stack([clap * 0.9, clap], axis=1) * 0.28)
        for half, pan in ((0, 0.4), (1, 0.6)):
            v = 0.14 if half else 0.08
            wrap_add(out, start + half * (beat // 2), np.stack([hat * (1 - pan), hat * pan], axis=1) * v)
    return out / np.max(np.abs(out))


def reverb(x, seconds=2.4, decay=0.6, wet=0.3, seed=5):
    """Circular convolution with a decaying-noise impulse (the loop's tail wraps into its start)."""
    rng = np.random.default_rng(seed)
    n = x.shape[0]
    m = int(seconds * SR)
    t = np.arange(m) / SR
    out = np.zeros_like(x)
    for ch in range(2):
        ir = rng.standard_normal(m) * np.exp(-t / decay)
        ir[: int(0.018 * SR)] = 0  # pre-delay
        ir = np.convolve(ir, np.ones(3) / 3, mode="same")  # soften the top
        ir /= np.sqrt(np.sum(ir**2))
        h = np.zeros(n)
        h[: min(m, n)] = ir[: min(m, n)]
        out[:, ch] = np.fft.irfft(np.fft.rfft(x[:, ch]) * np.fft.rfft(h), n)
    return x * (1 - wet) + out * wet


def ramp(n, points):
    """Piecewise-linear gain curve from [(seconds, gain), …]."""
    ts = np.array([p[0] for p in points]) * SR
    gs = np.array([p[1] for p in points])
    return np.interp(np.arange(n), ts, gs)


def music(duration, style):
    cfg = STYLES[style]
    rng = np.random.default_rng(cfg["seed"])
    beat = int(round(60 / cfg["bpm"] * SR))
    bar = 4 * beat
    chords = cfg["chords"]
    pad = pad_loop(chords, bar, rng)
    bass = bass_loop(chords, bar, beat)
    arp = arp_loop(chords, bar, beat, rng)
    drums = drum_loop(chords, bar, beat, rng)
    lush = reverb(pad * 0.55 + arp * 0.32, wet=0.38)
    n = int(duration * SR)
    reps = n // pad.shape[0] + 1
    tile = lambda x: np.tile(x, (reps, 1))[:n]
    lush, bass, drums, arp_dry = tile(lush), tile(bass), tile(drums), tile(arp)
    bar_s = bar / SR
    D = duration
    # Intro: bed only; drums and bass from bar 3; everything thins out for the last two bars.
    g_bed = ramp(n, [(0, 0), (2.0, 1), (D - 4.5, 1), (D, 0)])
    g_bass = ramp(n, [(0, 0), (2 * bar_s, 0), (2 * bar_s + 2, 0.55), (D - 2 * bar_s, 0.55), (D - 2, 0)])
    g_drums = ramp(n, [(0, 0), (2 * bar_s, 0), (2 * bar_s + 1.5, 0.42), (D - 2 * bar_s, 0.42), (D - 3, 0)])
    g_arp = ramp(n, [(0, 0.15), (2 * bar_s, 0.15), (2 * bar_s + 2, 0.3), (D - 3, 0.25), (D, 0)])
    mix = lush * g_bed[:, None] + bass * (g_bass * 0.5)[:, None] + drums * g_drums[:, None]
    mix += arp_dry * (g_arp * 0.25)[:, None]
    return mix


# ---------------------------------------------------------------------------
# Sound effects


def sfx(kind, rng):
    if kind in ("whoosh", "rise"):
        dur = 0.75 if kind == "whoosh" else 1.6
        n = int(dur * SR)
        t = np.arange(n) / SR
        noise = rng.standard_normal(n)
        # Sweep a resonant band-pass (state-variable filter) up and back down.
        if kind == "whoosh":
            fc = 350 + 2600 * np.sin(np.pi * t / dur) ** 2
        else:
            fc = 200 + 3200 * (t / dur) ** 2
        low = band = 0.0
        q = 0.32
        y = np.empty(n)
        for i in range(n):
            f = 2 * np.sin(np.pi * fc[i] / SR)
            high = noise[i] - low - q * band
            band += f * high
            low += f * band
            y[i] = band
        y = np.convolve(y, np.ones(6) / 6, mode="same")  # take the hiss off the top
        if kind == "whoosh":
            env = np.sin(np.pi * t / dur) ** 1.6
        else:
            env = np.sin(np.pi / 2 * t / dur) ** 4 * np.clip((dur - t) / 0.12, 0, 1)
        y *= env
        pan = np.linspace(0.3, 0.7, n)
        x = np.stack([y * (1 - pan), y * pan], axis=1)
        return x / np.max(np.abs(x)) * (db(-23) if kind == "whoosh" else db(-22))
    if kind == "click":
        n = int(0.06 * SR)
        t = np.arange(n) / SR
        tone = np.sin(2 * np.pi * 1850 * t) * np.exp(-t / 0.008) + 0.5 * np.sin(2 * np.pi * 950 * t) * np.exp(-t / 0.012)
        tick = rng.standard_normal(n) * np.exp(-t / 0.0015)
        y = tone * 0.8 + tick * 0.35
        return np.stack([y, y], axis=1) / np.max(np.abs(y)) * db(-23)
    if kind == "key":
        n = int(0.035 * SR)
        t = np.arange(n) / SR
        noise = rng.standard_normal(n)
        hp = noise - np.convolve(noise, np.ones(5) / 5, mode="same")
        f = rng.uniform(2200, 3200)
        y = hp * np.exp(-t / 0.004) + 0.4 * np.sin(2 * np.pi * f * t) * np.exp(-t / 0.006)
        pan = rng.uniform(0.4, 0.6)
        return np.stack([y * (1 - pan), y * pan], axis=1) / np.max(np.abs(y)) * db(-30)
    if kind == "pop":
        n = int(0.14 * SR)
        t = np.arange(n) / SR
        f = 420 + 700 * (1 - np.exp(-t / 0.02))
        y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.045) * (1 - np.exp(-t / 0.002))
        return np.stack([y, y], axis=1) / np.max(np.abs(y)) * db(-22)
    if kind == "chime":
        n = int(2.2 * SR)
        t = np.arange(n) / SR
        y = np.zeros(n)
        for base, at in ((hz(81), 0.0), (hz(88), 0.12)):  # A5 then E6
            s = int(at * SR)
            tt = t[: n - s]
            bell = sum(
                a * np.sin(2 * np.pi * base * r * tt) * np.exp(-tt / d)
                for r, a, d in ((1, 1, 0.9), (2.0, 0.35, 0.5), (2.76, 0.18, 0.3), (5.4, 0.07, 0.15))
            )
            y[s:] += bell * (1 - np.exp(-tt / 0.002))
        x = np.stack([y * 0.55, y * 0.45], axis=1)
        x = reverb(x, seconds=1.8, decay=0.5, wet=0.25, seed=9)
        return x / np.max(np.abs(x)) * db(-19)
    raise ValueError(f"unknown sfx {kind}")


# ---------------------------------------------------------------------------
# Voice: 24 kHz mono clips → 48 kHz, high-passed, levelled.


def load_voice(path):
    y, sr = sf.read(path, dtype="float64")
    if y.ndim > 1:
        y = y.mean(axis=1)
    spec = np.fft.rfft(y)
    freqs = np.fft.rfftfreq(y.size, 1 / sr)
    spec *= 1 / (1 + (70 / np.maximum(freqs, 1)) ** 4)  # gentle 70 Hz high-pass
    if sr != SR:
        n_out = int(round(y.size * SR / sr))
        full = np.zeros(n_out // 2 + 1, dtype=complex)
        full[: spec.size] = spec[: full.size]
        y = np.fft.irfft(full, n_out) * (SR / sr)
    else:
        y = np.fft.irfft(spec, y.size)
    rms = np.sqrt(np.mean(y[np.abs(y) > 0.01] ** 2)) if np.any(np.abs(y) > 0.01) else 1
    return y * (db(-17) / rms)


def envelope(x, attack=0.04, release=0.45, rate=200):
    """Smoothed level of a mono signal, sampled at `rate` Hz and returned at SR."""
    hop = SR // rate
    frames = x[: x.size // hop * hop].reshape(-1, hop)
    level = np.sqrt(np.mean(frames**2, axis=1))
    out = np.empty_like(level)
    a = np.exp(-1 / (attack * rate))
    r = np.exp(-1 / (release * rate))
    v = 0.0
    for i, l in enumerate(level):
        v = a * v + (1 - a) * l if l > v else r * v + (1 - r) * l
        out[i] = v
    return np.interp(np.arange(x.size), np.arange(out.size) * hop, out)


def main():
    job = json.load(open(sys.argv[1]))
    D = float(job["duration"])
    n = int(D * SR)
    rng = np.random.default_rng(3)

    voice = np.zeros(n)
    for clip in job.get("voice", []):
        y = load_voice(clip["file"])
        s = int(clip["start"] * SR)
        if s >= n:
            continue
        e = min(n, s + y.size)
        voice[s:e] += y[: e - s]

    bed = music(D, job.get("style", "pitch")) * db(-10)
    # Duck the music under the voice: about -7 dB while she speaks, back up between lines.
    if np.any(voice):
        lvl = envelope(voice)
        duck = 1 - 0.55 * np.clip(lvl / db(-24), 0, 1)
        bed *= duck[:, None]

    fx = np.zeros((n, 2))
    for ev in job.get("sfx", []):
        x = sfx(ev["kind"], rng)
        s = int(float(ev["t"]) * SR)
        if s >= n:
            continue
        e = min(n, s + x.shape[0])
        fx[s:e] += x[: e - s]

    mix = bed + fx + np.stack([voice, voice], axis=1)
    # Gentle limiter: soft-knee tanh above -3 dBFS.
    ceiling = db(-1.5)
    mix = np.where(np.abs(mix) > db(-3), np.sign(mix) * (db(-3) + (ceiling - db(-3)) * np.tanh((np.abs(mix) - db(-3)) / (ceiling - db(-3)))), mix)
    sf.write(sys.argv[2], mix.astype(np.float32), SR, subtype="PCM_24")
    print(f"soundtrack: {D:.1f} s, peak {20 * np.log10(np.max(np.abs(mix)) + 1e-9):.1f} dBFS", file=sys.stderr)


if __name__ == "__main__":
    main()
