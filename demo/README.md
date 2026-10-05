# Demo videos

Two parts, both rendered from this repo:

| Part            | Source                                         | Command                    | Output                      |
| --------------- | ---------------------------------------------- | -------------------------- | --------------------------- |
| 1 · Pitch       | `deck/deck.html` (12 slides, problem first)    | `npm run demo:deck`        | `out/part1-pitch.mp4`       |
| 2 · Walkthrough | `record-walkthrough.ts` (Playwright, demo app) | `npm run demo:walkthrough` | `out/part2-walkthrough.mp4` |

Each MP4 is 1920×1080 H.264 with narration, an original backing track and sound effects (AAC stereo, -16 LUFS), plus a
soft English subtitle track. Next to it: the same lines as `.srt`, and `partN-voiceover.md` with every line and its
start time.

- Open `deck/deck.html?slide=N` in a browser to look at one slide (N from 0).
- Slide timing: each `<section>` has `data-seconds` (minimum on screen) and `data-say` (its voice-over line); a slide
  stays up for the longer of the two, the line timed from its synthesized audio.
- The walkthrough's lines are the `LINES` map at the top of `record-walkthrough.ts`. It starts its own demo server on
  port 8795 (`DEMO_PORT`) from `dist/web`, so run `npm run build` first. Everything it shows is the demo fixture and is
  labelled as demo in the app.

| Piece          | Where                               | Notes                                                                                                  |
| -------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Voice          | `tts/kokoro_tts.py`, `lib/voice.ts` | Kokoro (Apache-2.0) via kokoro-onnx, offline, voice `af_heart`; cached in `out/.voice`.                |
| Speakable text | `lib/voice.ts` `spoken()`           | Subtitles keep digits; the voice gets "295 dollars", "N V D eh B", "to" for →.                         |
| Music, sound   | `audio/soundtrack.py`               | Synthesized here (pads, bass, arpeggio, drums; whoosh, click, key, pop, chime). Ducks under the voice. |
| Recording      | `lib/recorder.ts`                   | Chrome screencast frames → H.264; sound events and voice placed on the same clock.                     |

Requirements: ffmpeg with libx264 (`FFMPEG`), the Chromium build matching `playwright-core` (`CHROMIUM_PATH`), Python with
`pip install kokoro-onnx soundfile numpy`, and the two model files from the
[kokoro-onnx release](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0) in `.models/`.
`DEMO_VOICE=0` skips the voice; `KOKORO_VOICE` and `KOKORO_SPEED` change it.
