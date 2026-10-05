"""
Voice-over for the demo videos: Kokoro (82M, Apache-2.0) through kokoro-onnx, offline on CPU.

Reads a JSON job on stdin:
  {"model": ".../kokoro-v1.0.onnx", "voices": ".../voices-v1.0.bin", "voice": "af_heart",
   "speed": 1.0, "items": [{"id": "s01", "text": "...", "out": ".../abc.wav"}]}
Writes each item as 24 kHz mono 16-bit WAV (skipping files that already exist: the
caller names them by a hash of text, voice and speed) and prints {"id": seconds, ...}.

  pip install kokoro-onnx soundfile
  model files: github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0
"""
import json
import os
import sys

import soundfile as sf
from kokoro_onnx import Kokoro

job = json.load(sys.stdin)
kokoro = None
durations = {}
for item in job["items"]:
    out = item["out"]
    if not os.path.exists(out):
        if kokoro is None:
            kokoro = Kokoro(job["model"], job["voices"])
        samples, sr = kokoro.create(item["text"], voice=job["voice"], speed=job["speed"], lang="en-us")
        tmp = out + ".tmp.wav"
        sf.write(tmp, samples, sr, subtype="PCM_16")
        os.replace(tmp, out)
    info = sf.info(out)
    durations[item["id"]] = info.frames / info.samplerate
    print(f"tts {item['id']}: {durations[item['id']]:.2f} s", file=sys.stderr)
print(json.dumps(durations))
