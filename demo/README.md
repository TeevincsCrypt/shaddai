# Demo videos

Two parts, both rendered from this repo:

| Part            | Source                                         | Command                    | Output                      |
| --------------- | ---------------------------------------------- | -------------------------- | --------------------------- |
| 1 · Pitch       | `deck/deck.html` (12 slides, problem first)    | `npm run demo:deck`        | `out/part1-pitch.mp4`       |
| 2 · Walkthrough | `record-walkthrough.ts` (Playwright, demo app) | `npm run demo:walkthrough` | `out/part2-walkthrough.mp4` |

Each MP4 is 1920×1080 H.264 with a soft English subtitle track. Next to it: the same lines as `.srt`, and
`partN-voiceover.md` with every line and its start time, for recording a voice-over. The videos themselves are silent.

- Open `deck/deck.html?slide=N` in a browser to look at one slide (N from 0).
- Slide timing: each `<section>` has `data-seconds` (minimum on screen) and `data-say` (its voice-over line); a slide
  stays up for the longer of the two at about 156 words a minute.
- The walkthrough starts its own demo server on port 8795 (`DEMO_PORT`) from `dist/web`, so run `npm run build` first.
  Everything it shows is the demo fixture and is labelled as demo in the app.
- Requirements: ffmpeg with libx264 (`FFMPEG=/path/to/ffmpeg`, default `ffmpeg` on `PATH`) and the Chromium build that
  matches `playwright-core` (`npx playwright install chromium`, or `CHROMIUM_PATH`).
