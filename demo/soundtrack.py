"""The demo video's sound, built from timeline.json (demo/compose.cjs) and the recorder's frames.jsonl.

Where the recording plays at normal speed, the sound the window was playing at that moment is put back: each played
item's cleaned sound (sound/<id>.bin), from the position its <audio> reported, so sound and picture line up.
"Before" is the link video's original sound, "after" its cleaned sound at the same moment. Fast parts and cards are
quiet, with a soft tick for each click and key. Writes soundtrack.wav and levels.json (voice and music level per
frame, for the meters on the "before / after" cards).
Folders as in compose.cjs: NAQI_DEMO_DIR, NAQI_DEMO_WORK, NAQI_DEMO_SOURCE, NAQI_DEMO_BEFORE_AT.
"""
import json
import os
import subprocess
import wave

import numpy as np

REC = os.environ["NAQI_DEMO_DIR"]
WORK = os.environ["NAQI_DEMO_WORK"]
SOURCE = os.environ["NAQI_DEMO_SOURCE"]
SR = 48000
FPS = 30
PER = SR // FPS


def decode(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).copy()


def take(x, start_s, n):
    """n samples of x from start_s (silence outside it)."""
    a = int(round(start_s * SR))
    out = np.zeros((n, 2), np.float32)
    lo, hi = max(a, 0), min(a + n, len(x))
    if hi > lo:
        out[lo - a:hi - a] = x[lo:hi]
    return out


def fade(seg, ms=12):
    k = min(len(seg) // 2, int(SR * ms / 1000))
    if k:
        ramp = np.linspace(0, 1, k, dtype=np.float32)[:, None]
        seg[:k] *= ramp
        seg[-k:] *= ramp[::-1]
    return seg


def tick(gain):
    """A soft click: a short, quickly fading high tone with a breath of noise."""
    n = int(SR * 0.035)
    t = np.arange(n) / SR
    rng = np.random.default_rng(3)
    s = (np.sin(2 * np.pi * 2300 * t) * 0.6 + rng.standard_normal(n) * 0.25) * np.exp(-t * 160)
    return (s * gain).astype(np.float32)[:, None].repeat(2, 1)


def main():
    tl = json.load(open(os.path.join(WORK, "timeline.json"), encoding="utf-8"))
    rec = [json.loads(l) for l in open(os.path.join(REC, "frames.jsonl"), encoding="utf-8") if l.strip()]
    frames = tl["frames"]
    n_out = len(frames)
    track = np.zeros((n_out * PER, 2), np.float32)
    sounds = {}

    def sound(src):
        if src not in sounds:
            sounds[src] = decode(os.path.join(REC, "sound", src.replace("/", "_") + ".bin"))
        return sounds[src]

    # The recording at normal speed: find runs where one item plays on smoothly
    runs, cur = [], None
    for i, f in enumerate(frames):
        m = None
        if f.get("r") is not None and not f.get("ff") and f.get("card") != "chapter":
            ms = rec[f["r"]]["m"]
            m = ms[0] if ms else None
        if m and cur and cur["src"] == m["s"] and cur["last"] == i - 1 and 0 < m["at"] - cur["at"] < 0.25:
            cur["k"].append((i, m["at"], m["v"]))
            cur["last"], cur["at"] = i, m["at"]
            continue
        if m and cur and cur["src"] == m["s"] and cur["last"] == i - 1 and abs(m["at"] - cur["at"]) < 1e-3:
            cur["last"] = i   # the same sample again: the page reported late, keep going
            cur["k"].append((i, None, m["v"]))
            continue
        cur = None
        if m:
            cur = {"src": m["s"], "k": [(i, m["at"], m["v"])], "last": i, "at": m["at"]}
            runs.append(cur)
    link_src = runs[0]["src"] if runs else None
    for run in runs:
        i0 = run["k"][0][0]
        offs = [at - (i - i0) / FPS for i, at, _ in run["k"] if at is not None]
        anchor = float(np.median(offs))
        n = (run["k"][-1][0] - i0 + 1) * PER
        vol = float(np.median([v for _, _, v in run["k"]]))
        seg = take(sound(run["src"]), anchor, n) * vol
        track[i0 * PER:i0 * PER + n] += fade(seg)

    # Before / after
    orig = decode(SOURCE)
    clean = sound(link_src) if link_src else np.zeros_like(orig)
    at = tl["beforeAt"]
    levels = []
    for i, f in enumerate(frames):
        card = f.get("card")
        if card in ("before", "after"):
            t = at + f["ct"]
            o, c = take(orig, t, PER), take(clean, t, PER)
            track[i * PER:(i + 1) * PER] = o if card == "before" else c
        a = track[i * PER:(i + 1) * PER]
        lv = lambda x: float(np.clip((10 * np.log10(np.mean(x ** 2) + 1e-10) + 52) / 40, 0, 1))
        if card in ("before", "after"):
            t = at + f["ct"]
            o, c = take(orig, t, PER), take(clean, t, PER)
            levels.append([round(lv(c), 3), round(lv(o - c), 3) if card == "before" else 0])
        else:
            levels.append([round(lv(a), 3), 0])
    for k in ("before", "after"):
        idx = [i for i, f in enumerate(frames) if f.get("card") == k]
        if idx:
            a, b = idx[0] * PER, (idx[-1] + 1) * PER
            track[a:b] = fade(track[a:b].copy(), 40)

    # Loudness: the voice around -20 dB, never clipping
    loud = track[np.abs(track).max(1) > 1e-3]
    if len(loud):
        track *= 10 ** ((-20 - 10 * np.log10(np.mean(loud ** 2) + 1e-12)) / 20)
    # soft ticks for clicks and keys
    for c in tl["clicks"] + tl["keys"]:
        s = tick(0.09)
        a = c["at"] * PER
        track[a:a + len(s)] += s[:max(0, len(track) - a)]
    track = np.tanh(track * 1.05) / np.tanh(1.05)

    pcm = (np.clip(track, -1, 1) * 32767).astype("<i2")
    with wave.open(os.path.join(WORK, "soundtrack.wav"), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    json.dump(levels, open(os.path.join(WORK, "levels.json"), "w"))
    played = sum((r["k"][-1][0] - r["k"][0][0] + 1) for r in runs) / FPS
    print(f"soundtrack: {n_out / FPS:.0f} s, {len(runs)} played parts ({played:.0f} s of app sound), link sound {link_src}")


if __name__ == "__main__":
    main()
