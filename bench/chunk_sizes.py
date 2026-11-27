"""T10.9: cleaning pieces of 2 / 5 / 15 min (now) against 2 / 5 / 5 min, on the same samples.
Usage: py -3.12 bench/chunk_sizes.py [file ...]   (default: samples/narration_over_music.mp3, samples/long_41min.mp3)
Runs clean_to_wav (the player's chunked cleaning) with each plan, in the order A B B A for long files (so a slower
or warmer PC does not favour one plan). Prints and writes test_out/t10.9/results.json: total time, speed, peak VRAM,
start delay (first moment playback may start), every moment the clean part grew, and a click check at each join:
the largest sample-to-sample jump within 25 ms of the join against the 99.9th percentile of the whole file (a click
would stand far above 1), plus how far the two plans' sound differs around the joins only one plan has.
"""
import json
import os
import sys
import time
import wave

import numpy as np

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(HERE, "engine"))

import speech_only  # noqa: E402

OUT = os.path.join(HERE, "test_out", "t10.9")
PLANS = {"A_2-5-15": [120, 300, 900], "B_2-5-5": [120, 300, 300]}


def read_wav(path):
    with wave.open(path) as w:
        return np.frombuffer(w.readframes(w.getnframes()), "<i2").reshape(-1, 2).astype(np.float32) / 32768


def join_check(y, joins_s):
    d = np.abs(np.diff(y, axis=0)).max(axis=1)
    p999 = float(np.percentile(d, 99.9))
    w = round(0.025 * speech_only.SR)
    rows = []
    for t in joins_s:
        n = round(t * speech_only.SR)
        rows.append({"at_s": round(t, 2), "jump_ratio": round(float(d[max(0, n - w):n + w].max()) / p999, 2)})
    return rows


def run(src, name, plan):
    speech_only.CHUNKS_S = plan
    wav = os.path.join(OUT, f"{os.path.splitext(os.path.basename(src))[0]}_{name}.wav")
    grows, t0 = [], time.perf_counter()

    def ready(seconds, plays):
        grows.append({"after_s": round(time.perf_counter() - t0, 1), "clean_s": round(seconds, 1), "plays": plays})

    r = speech_only.clean_to_wav(src, wav, ready=ready)
    joins = [g["clean_s"] for g in grows[:-1]]
    starts = [g["after_s"] for g in grows if g["plays"]]
    gaps = np.diff([0.0] + [g["after_s"] for g in grows])
    return {
        "plan": name, "file": os.path.basename(src), "wav": wav,
        "duration_s": round(r["duration_s"], 1), "seconds": round(r["seconds"], 1), "speed_x": round(r["speed_x"], 2),
        "peak_vram_gb": round(r["peak_vram_mb"] / 1024, 2), "device": r["device"],
        "start_delay_s": starts[0] if starts else None, "first_chunk_s": round(r["first_chunk_s"], 1),
        "grows": grows, "grow_every_s": round(float(np.mean(gaps[1:])), 1) if len(gaps) > 1 else None,
        "joins": join_check(read_wav(wav), joins), "muted_fraction": round(r["muted_fraction"], 4),
    }


def compare(a, b):
    """How much the two plans' sound differs, within 1 s of every join (dB below the sound's own level)."""
    ya, yb = read_wav(a["wav"]), read_wav(b["wav"])
    n = min(len(ya), len(yb))
    ya, yb = ya[:n], yb[:n]
    level = float(np.sqrt(np.mean(ya ** 2))) or 1e-9
    out = []
    for t in sorted({j["at_s"] for j in a["joins"] + b["joins"]}):
        c, w = round(t * speech_only.SR), speech_only.SR
        diff = float(np.sqrt(np.mean((ya[max(0, c - w):c + w] - yb[max(0, c - w):c + w]) ** 2)))
        out.append({"at_s": t, "diff_db": round(20 * np.log10(max(diff, 1e-9) / level), 1)})
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    files = sys.argv[1:] or [os.path.join(HERE, "samples", f) for f in ("narration_over_music.mp3", "long_41min.mp3")]
    results = []
    for src in files:
        long = speech_only.duration_of(src) > 600
        order = ["A_2-5-15", "B_2-5-5", "B_2-5-5", "A_2-5-15"] if long else ["A_2-5-15", "B_2-5-5"]
        done = {}
        for name in order:
            r = run(src, name, PLANS[name])
            print(json.dumps({k: v for k, v in r.items() if k not in ("grows", "wav")}), flush=True)
            results.append(r)
            done[name] = r
        results.append({"file": os.path.basename(src), "plans_differ_at_joins": compare(done["A_2-5-15"],
                                                                                       done["B_2-5-5"])})
        print(json.dumps(results[-1]), flush=True)
    speech_only.CHUNKS_S = PLANS["A_2-5-15"]
    with open(os.path.join(OUT, "results.json"), "w", encoding="utf-8") as f:
        json.dump(results, f, indent=1)


if __name__ == "__main__":
    main()
