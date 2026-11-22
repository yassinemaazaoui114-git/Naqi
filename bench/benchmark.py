"""Accuracy benchmark + VAD tuning for the old "talking only" method (Demucs + Silero VAD, kept in speech_only.py).
Scores: "speech lost" = seconds of speech that got muted, "music leaked" = seconds of music that stayed audible,
"slips" = such mistakes longer than 0.5 s (what you actually hear). Moments within 0.2 s of a label edge are not
scored (labels are fuzzy at word edges).

Data lives outside OneDrive and git, in NAQI_DATA (default %USERPROFILE%\\Naqi-data):
  musan/        MUSAN (openslr.org/17, CC BY 4.0), unpacked: music/ and speech/ are mixed at known times
  smad/         AVASpeech-SMAD: audio/<id>.flac = minutes 15-30 of each clip in subset.txt, labels/ = human labels
  cases/        audio of your own slip cases (the list itself is slip_cases.csv, in the same folder)
  cache/        per item: Demucs vocals (16 kHz), VAD scores and the truth, so Demucs runs only once per file

Usage (python -I because the data files are downloaded):
  python -I benchmark.py prepare          run Demucs on everything not cached yet (new slip cases too)
  python -I benchmark.py score [--threshold 0.5] [--min-silence 400] [--pad 150]
  python -I benchmark.py tune             try many settings on the saved vocals, print the trade-off
  python -I benchmark.py add SOURCE START END music|speech|singing|effects [note]
        SOURCE = file or YouTube link, START/END = seconds or m:ss, music = must be removed, the others = must stay
        (the app's "Report a slip" page saves cases the same way)
  python -I benchmark.py explain SOURCE TIME
  python -I benchmark.py listen [--count 8]   worst slips as short WAVs in NAQI_DATA/listen, to check by ear
"""
import argparse
import glob
import itertools
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)   # python -I leaves the script's folder out
sys.path.insert(0, os.path.join(HERE, "..", "engine"))   # copied from old Naqi (2026-11-22): the engine lives there now

import numpy as np
import soundfile as sf
import torch

import speech_only as so
from cases import CASES_CSV, case_audio, case_key, read_cases, save_case  # noqa: F401 (r7_bench uses them)
from files import is_link

DATA = os.environ.get("NAQI_DATA") or os.path.join(os.path.expanduser("~"), "Naqi-data")
CACHE = os.path.join(DATA, "cache")
HOP = 0.01            # truth and results are compared on a 10 ms grid
COLLAR_S = 0.2        # not scored this close to a label edge
SLIP_S = 0.5          # a mistake longer than this is a "slip"
MERGE_GAP_S = 0.5     # MUSAN truth: pauses shorter than this inside speech count as speech

# Truth classes per 10 ms
OTHER, SPEECH, MUSIC, SINGING, BOTH = range(5)   # BOTH = SMAD "speech + music": talking over music or a song

# MUSAN mixes: 40 s each, one music track all the way, speech parts at random times
MIX_S = 40
MIX_SR = 16000        # MUSAN is 16 kHz; the app's ffmpeg step turns it into 44.1 kHz stereo for Demucs
N_MIXES = 320
LEVELS = [15, 5, 0, -5]   # speech is this many dB louder than the music (-5 = music louder than speech)
SPEECH_DB = -23.0


# ---------- small helpers ----------

def runs(mask):
    """Lengths in seconds of each stretch of True."""
    d = np.diff(np.concatenate([[0], mask.astype(np.int8), [0]]))
    return (np.flatnonzero(d == -1) - np.flatnonzero(d == 1)) * HOP


def fill_gaps(mask, gap_s, min_s):
    """Close False gaps shorter than gap_s, then drop True stretches shorter than min_s."""
    mask = mask.copy()
    d = np.diff(np.concatenate([[0], mask.astype(np.int8), [0]]))
    starts, ends = np.flatnonzero(d == 1), np.flatnonzero(d == -1)
    for e, s in zip(ends[:-1], starts[1:]):
        if (s - e) * HOP < gap_s:
            mask[e:s] = True
    d = np.diff(np.concatenate([[0], mask.astype(np.int8), [0]]))
    for s, e in zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)):
        if (e - s) * HOP < min_s:
            mask[s:e] = False
    return mask


def frame_db(x, sr):
    """Loudness (dB) of each 10 ms frame."""
    n = int(sr * HOP)
    x = x[:len(x) // n * n].reshape(-1, n)
    return 10 * np.log10((x.astype(np.float64) ** 2).mean(1) + 1e-10)


def kept_mask(parts, n):
    k = np.zeros(n, bool)
    for a, b in parts:
        k[int(round(a / HOP)):int(round(b / HOP))] = True
    return k


def collar(cat):
    """True within COLLAR_S of any change of class."""
    edge = np.zeros(len(cat), np.float32)
    edge[np.flatnonzero(cat[1:] != cat[:-1]) + 1] = 1
    w = int(COLLAR_S / HOP)
    return np.convolve(edge, np.ones(2 * w + 1), "same") > 0


def save_item(name, vocals, cat, **meta):
    os.makedirs(os.path.dirname(name), exist_ok=True)
    probs = so.vad_probs(vocals)
    np.savez(name + ".tmp.npz", vocals=vocals.numpy().astype(np.float16), probs=probs, cat=cat,
             n=len(vocals), **{k: str(v) for k, v in meta.items()})
    os.replace(name + ".tmp.npz", name + ".npz")


# ---------- MUSAN: build mixes at known times ----------

def musan_pools():
    """(instrumental files, files with singing, speech files), always in the same order."""
    inst, sing = [], []
    for ann in sorted(glob.glob(os.path.join(DATA, "musan", "music", "*", "ANNOTATIONS"))):
        folder = os.path.dirname(ann)
        for line in open(ann, encoding="utf-8", errors="replace"):
            p = line.split()
            if len(p) >= 3 and p[2] in ("Y", "N"):
                f = os.path.join(folder, p[0] + ".wav")
                if os.path.exists(f):
                    (sing if p[2] == "Y" else inst).append(f)
    speech = sorted(glob.glob(os.path.join(DATA, "musan", "speech", "*", "*.wav")))
    return inst, sing, speech


def speech_chunk(rng, speech_files):
    """A 3-10 s piece of clean speech, trimmed to start and end on a word, and its speech/no-speech frames."""
    while True:
        f = speech_files[rng.integers(len(speech_files))]
        n = sf.info(f).frames
        length = int(rng.uniform(3, 10) * MIX_SR)
        if n < length + MIX_SR:
            continue
        start = int(rng.integers(0, n - length))
        x, _ = sf.read(f, start=start, frames=length, dtype="float32")
        x = x if x.ndim == 1 else x.mean(1)
        db = frame_db(x, MIX_SR)
        act = fill_gaps(db > max(db.max() - 35, -55), MERGE_GAP_S, 0.15)
        on = np.flatnonzero(act)
        if len(on) < 0.5 * len(act):
            continue
        a, b = on[0], on[-1] + 1
        hop = int(MIX_SR * HOP)
        return x[a * hop:b * hop], act[a:b], os.path.basename(f)


def singing_frames(music, tmpdir):
    """Where a song really has a voice: the Demucs vocals of the music alone are loud enough."""
    p = os.path.join(tmpdir, "music.wav")
    sf.write(p, music, MIX_SR, subtype="FLOAT")
    voc = so.vocals16(p).numpy()
    vdb, mdb = frame_db(voc, so.VAD_SR), frame_db(music, MIX_SR)
    n = min(len(vdb), len(mdb))
    return fill_gaps((vdb[:n] > mdb[:n] - 12) & (vdb[:n] > -45), 0.3, 0.2), n


def build_mix(i, pools, tmpdir):
    """Mix number i (always the same for the same i). Returns (path of the mix, truth classes, kind)."""
    inst, sing, speech = pools
    rng = np.random.default_rng(1000 + i)
    singing = i % 2 == 0
    level = LEVELS[(i // 2) % len(LEVELS)]
    files = sing if singing else inst
    while True:
        mf = files[rng.integers(len(files))]
        n = sf.info(mf).frames
        if n > (MIX_S + 5) * MIX_SR:
            break
    start = int(rng.integers(0, n - MIX_S * MIX_SR))
    music, _ = sf.read(mf, start=start, frames=MIX_S * MIX_SR, dtype="float32")
    music = music if music.ndim == 1 else music.mean(1)
    frames = int(MIX_S / HOP)
    voice = np.zeros_like(music)
    is_speech = np.zeros(frames, bool)
    t = rng.uniform(1.5, 5)
    while True:
        x, act, _ = speech_chunk(rng, speech)
        if t + len(x) / MIX_SR > MIX_S - 1.5:
            break
        x = x * 10 ** ((SPEECH_DB - 10 * np.log10((x[np.repeat(act, int(MIX_SR * HOP))[:len(x)]] ** 2).mean()
                                                  + 1e-10)) / 20)
        a = int(t * MIX_SR)
        voice[a:a + len(x)] = x
        fa = int(round(t / HOP))
        is_speech[fa:fa + len(act)] |= act[:frames - fa]
        t += len(x) / MIX_SR + rng.uniform(1.5, 6)
    music_db = 10 * np.log10((music ** 2).mean() + 1e-10)
    music = music * 10 ** ((SPEECH_DB - level - music_db) / 20)
    mix = voice + music
    peak = np.abs(mix).max()
    if peak > 0.99:
        mix *= 0.99 / peak
    cat = np.full(frames, MUSIC, np.uint8)
    if singing:
        sung, n_sung = singing_frames(music, tmpdir)
        cat[:n_sung][sung] = SINGING
    cat[is_speech] = SPEECH
    path = os.path.join(tmpdir, f"mix{i:03d}.wav")
    sf.write(path, mix, MIX_SR, subtype="FLOAT")
    kind = f"{'singing' if singing else 'instrumental'}, speech {level:+d} dB"
    return path, cat, kind, os.path.basename(mf)


def prepare_musan():
    if not os.path.isdir(os.path.join(DATA, "musan", "music")):
        print("MUSAN not found in", os.path.join(DATA, "musan"), "- skipped")
        return
    pools = musan_pools()
    print(f"MUSAN: {len(pools[0])} instrumental, {len(pools[1])} with singing, {len(pools[2])} speech files")
    with tempfile.TemporaryDirectory() as tmp:
        for i in range(N_MIXES):
            name = os.path.join(CACHE, "musan", f"mix{i:03d}")
            if os.path.exists(name + ".npz"):
                continue
            path, cat, kind, music = build_mix(i, pools, tmp)
            save_item(name, so.vocals16(path), cat, kind=kind, music=music)
            os.remove(path)
            print(f"  mix {i + 1}/{N_MIXES}: {kind}", flush=True)


# ---------- AVASpeech-SMAD ----------

def smad_truth(cid, frames):
    lab = os.path.join(DATA, "smad", "labels", "AVASpeech_Music_Labels-main", "labels")
    sp, mu = np.zeros(frames, bool), np.zeros(frames, bool)
    # Speech rows: "s" and "m" (speech with music) both count as speech, as in the dataset's own script
    for path, sep, mask in ((os.path.join(lab, "speech labels", cid + ".csv"), "\t", sp),
                            (os.path.join(lab, "music labels", cid + ".csv"), ",", mu)):
        for line in open(path, encoding="utf-8"):
            p = line.strip().split(sep)
            if len(p) >= 2:
                mask[int(round(float(p[0]) / HOP)):int(round(float(p[1]) / HOP))] = True
    cat = np.full(frames, OTHER, np.uint8)
    cat[sp & ~mu], cat[mu & ~sp], cat[sp & mu] = SPEECH, MUSIC, BOTH
    return cat


def prepare_smad():
    subset = os.path.join(DATA, "smad", "subset.txt")
    if not os.path.exists(subset):
        print("AVASpeech-SMAD not found - skipped")
        return
    for cid in open(subset).read().split():
        name = os.path.join(CACHE, "smad", cid)
        audio = os.path.join(DATA, "smad", "audio", cid + ".flac")
        if os.path.exists(name + ".npz") or not os.path.exists(audio):
            continue
        vocals = so.vocals16(audio)
        save_item(name, vocals, smad_truth(cid, int(len(vocals) / so.VAD_SR / HOP)), kind=cid)
        print(f"  SMAD {cid} done", flush=True)


# ---------- your own slip cases ----------

def prepare_cases():
    for source in sorted({c["source"] for c in read_cases()}):
        name = os.path.join(CACHE, "cases", case_key(source))
        if os.path.exists(name + ".npz"):
            continue
        vocals = so.vocals16(case_audio(source))
        save_item(name, vocals, np.zeros(0, np.uint8), kind=source)
        print(f"  case {source} done", flush=True)


def add_case(source, start, end, expect, note):
    try:
        save_case(source, start, end, expect, note)   # copies/downloads the sound now, so the case stays
    except ValueError as ex:
        sys.exit(str(ex))
    print("Added. Run 'python -I benchmark.py prepare' once, then score/tune include it.")


# ---------- scoring ----------

def load(dataset):
    items = []
    for f in sorted(glob.glob(os.path.join(CACHE, dataset, "*.npz"))):
        with np.load(f) as z:
            items.append({"probs": z["probs"], "cat": z["cat"], "n": int(z["n"]), "kind": str(z["kind"]),
                          "file": f})
    return items


def score_item(it, setting):
    parts = so.parts_from_probs(it["probs"], it["n"], *setting)
    cat = it["cat"]
    kept = kept_mask(parts, len(cat))
    ok = ~collar(cat)
    lost = (cat == SPEECH) & ~kept & ok
    leak = np.isin(cat, (MUSIC, SINGING)) & kept & ok
    sung = (cat == SINGING) & kept & ok
    return {
        "hours": len(cat) * HOP / 3600,
        "speech_s": ((cat == SPEECH) & ok).sum() * HOP, "lost_s": lost.sum() * HOP,
        "music_s": (np.isin(cat, (MUSIC, SINGING)) & ok).sum() * HOP, "leak_s": leak.sum() * HOP,
        "sing_s": ((cat == SINGING) & ok).sum() * HOP, "sing_leak_s": sung.sum() * HOP,
        "lost_slips": int((runs(lost) > SLIP_S).sum()), "leak_slips": int((runs(leak) > SLIP_S).sum()),
        "sing_slips": int((runs(sung) > SLIP_S).sum()),
        "other_s": ((cat == OTHER) & ok).sum() * HOP, "other_kept_s": ((cat == OTHER) & kept & ok).sum() * HOP,
        "both_s": ((cat == BOTH) & ok).sum() * HOP, "both_kept_s": ((cat == BOTH) & kept & ok).sum() * HOP,
    }


def add_up(rows):
    return {k: sum(r[k] for r in rows) for k in rows[0]}


def pct(a, b):
    return f"{100 * a / b:5.1f}%" if b else "    -"


def print_table(title, groups):
    print(f"\n{title}")
    print(f"  {'kind':34} {'audio':>6} | {'speech lost':>15} {'slips':>5} | {'music leaked':>16} {'slips':>5} | "
          f"{'singing leaked':>15} | {'noise kept':>10} | {'speech+music kept':>17}")
    for kind, r in groups:
        print(f"  {kind:34} {r['hours'] * 60:5.0f}m | {r['lost_s']:6.0f}s {pct(r['lost_s'], r['speech_s'])} "
              f"{r['lost_slips']:5d} | {r['leak_s']:7.0f}s {pct(r['leak_s'], r['music_s'])} {r['leak_slips']:5d} | "
              f"{r['sing_leak_s']:6.0f}s {pct(r['sing_leak_s'], r['sing_s'])} | {pct(r['other_kept_s'], r['other_s']):>10} | "
              f"{pct(r['both_kept_s'], r['both_s']):>17}")


def score_cases(setting):
    """[(case, wrong seconds, longest wrong stretch)] for each of your slip cases."""
    out = []
    cache = {}
    for c in read_cases():
        key = case_key(c["source"])
        if key not in cache:
            f = os.path.join(CACHE, "cases", key + ".npz")
            if not os.path.exists(f):
                out.append((c, None, None))
                continue
            with np.load(f) as z:
                cache[key] = (z["probs"], int(z["n"]))
        probs, n = cache[key]
        frames = int(n / so.VAD_SR / HOP)
        kept = kept_mask(so.parts_from_probs(probs, n, *setting), frames)
        a, b = int(so.parse_time(c["start"]) / HOP), int(so.parse_time(c["end"]) / HOP)
        wrong = kept[a:b] if c["expect"] == "music" else ~kept[a:b]
        r = runs(wrong)
        out.append((c, wrong.sum() * HOP, r.max() if len(r) else 0.0))
    return out


def cmd_score(setting):
    print(f"Setting: threshold {setting[0] or so.VAD_THRESHOLD}, min silence {setting[1] or so.VAD_MIN_SILENCE_MS} ms,"
          f" pad {setting[2] or so.VAD_PAD_MS} ms. Not scored: {COLLAR_S} s around label edges. Slip = over {SLIP_S} s.")
    for dataset, title in (("musan", "MUSAN mixes (speech over music at known times)"),
                           ("smad", "AVASpeech-SMAD (real YouTube movies, human labels)")):
        items = load(dataset)
        if not items:
            print(f"\n{title}: nothing prepared yet")
            continue
        rows = [(it["kind"], score_item(it, setting)) for it in items]
        groups = {}
        for kind, r in rows:
            groups.setdefault(kind, []).append(r)
        table = [(k, add_up(v)) for k, v in sorted(groups.items())]
        print_table(title, table + [("ALL", add_up([r for _, r in rows]))])
        if dataset == "musan":
            by = {}
            for kind, r in rows:
                by.setdefault(kind.split(",")[0], []).append(r)
            print_table("MUSAN by music type", [(k, add_up(v)) for k, v in sorted(by.items())])
    cases = score_cases(setting)
    if cases:
        print("\nYour slip cases")
        for c, wrong, longest in cases:
            if wrong is None:
                print(f"  NOT PREPARED  {c['source']} {c['start']}-{c['end']} (run prepare)")
                continue
            ok = longest <= SLIP_S
            print(f"  {'PASS' if ok else 'FAIL'}  {c['expect']:6} {c['start']}-{c['end']}  wrong {wrong:.1f}s "
                  f"(longest {longest:.1f}s)  {c['source']}  {c['note']}")


THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
MIN_SILENCES = [100, 200, 400, 600, 800]
PADS = [30, 100, 150, 250, 350, 500]


def cmd_tune(top):
    sets = {d: load(d) for d in ("musan", "smad")}
    sets = {d: v for d, v in sets.items() if v}
    if not sets:
        sys.exit("Nothing prepared yet: run 'python -I benchmark.py prepare' first.")
    base = (so.VAD_THRESHOLD, so.VAD_MIN_SILENCE_MS, so.VAD_PAD_MS)
    results = []
    t0 = time.perf_counter()
    for setting in itertools.product(THRESHOLDS, MIN_SILENCES, PADS):
        row = {"setting": setting}
        for d, items in sets.items():
            row[d] = add_up([score_item(it, setting) for it in items])
        cases = score_cases(setting)
        row["cases_failed"] = sum(1 for _, w, longest in cases if w is not None and longest > SLIP_S)
        # Goal: fewest slips you can hear, each dataset weighted the same (slips per hour, averaged)
        row["goal"] = np.mean([(r["lost_slips"] + r["leak_slips"]) / r["hours"] for r in
                               (row[d] for d in sets)])
        results.append(row)
    print(f"{len(results)} settings tried in {time.perf_counter() - t0:.0f} s. Numbers are per hour of audio.")
    results.sort(key=lambda r: (r["cases_failed"], r["goal"]))
    shown = results[:top] + [r for r in results if r["setting"] == base and r not in results[:top]]
    head = f"  {'thr':>4} {'sil':>4} {'pad':>4} |"
    for d in sets:
        head += f" {d + ' lost s':>12} {'leak s':>7} {'slips':>6} |"
    print(head + " cases failed")
    for r in shown:
        th, sil, pad = r["setting"]
        line = f"  {th:4.2f} {sil:4d} {pad:4d} |"
        for d in sets:
            x = r[d]
            line += (f" {x['lost_s'] / x['hours']:12.0f} {x['leak_s'] / x['hours']:7.0f}"
                     f" {(x['lost_slips'] + x['leak_slips']) / x['hours']:6.0f} |")
        print(line + f" {r['cases_failed']:5d}" + ("   <- app now" if r["setting"] == base else ""))


def original_audio(item, tmpdir):
    """The audio as it was before cleaning (16 kHz mono): SMAD from its FLAC, MUSAN mixes rebuilt from the seed."""
    name = os.path.splitext(os.path.basename(item["file"]))[0]
    if "musan" in item["file"]:
        path = build_mix(int(name[3:]), musan_pools(), tmpdir)[0]
    else:
        path = os.path.join(DATA, "smad", "audio", name + ".flac")
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(so.VAD_SR), "-f", "f32le",
                          "pipe:1"], capture_output=True, stdin=subprocess.DEVNULL).stdout
    return name, np.frombuffer(raw, np.float32)


def cmd_listen(count, setting):
    """Writes the worst slips as short WAVs to NAQI_DATA/listen: '<n> lost|leaked <item> <time> original.wav' and
    '... cleaned.wav' (what Naqi keeps, 16 kHz). Listening tells label mistakes apart from real slips."""
    out = os.path.join(DATA, "listen")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    slips = []
    for d in ("musan", "smad"):
        for it in load(d):
            cat, ok = it["cat"], ~collar(it["cat"])
            kept = kept_mask(so.parts_from_probs(it["probs"], it["n"], *setting), len(cat))
            for what, mask in (("lost", (cat == SPEECH) & ~kept & ok),
                               ("leaked", np.isin(cat, (MUSIC, SINGING)) & kept & ok)):
                d_ = np.diff(np.concatenate([[0], mask.astype(np.int8), [0]]))
                for a, b in zip(np.flatnonzero(d_ == 1), np.flatnonzero(d_ == -1)):
                    if (b - a) * HOP > SLIP_S:
                        slips.append(((b - a) * HOP, what, it, a * HOP, b * HOP))
    slips.sort(key=lambda s: -s[0])
    chosen = [s for s in slips if s[1] == "lost"][:count] + [s for s in slips if s[1] == "leaked"][:count]
    with tempfile.TemporaryDirectory() as tmp:
        for k, (length, what, it, a, b) in enumerate(chosen, 1):
            name, x = original_audio(it, tmp)
            with np.load(it["file"]) as z:
                voc = z["vocals"].astype(np.float32)
            parts = so.parts_from_probs(it["probs"], it["n"], *setting)
            lo, hi = max(0.0, a - 2), min(len(x) / so.VAD_SR, b + 2, a + 12)
            t = np.arange(int(lo * so.VAD_SR), int(hi * so.VAD_SR)) / so.VAD_SR
            xs = [p for a_, b_ in parts for p in (a_ - so.FADE_S, a_, b_, b_ + so.FADE_S)]
            ys = [0.0, 1.0, 1.0, 0.0] * len(parts)
            gain = np.interp(t, xs, ys, left=0.0, right=0.0) if parts else np.zeros_like(t)
            i0, i1 = int(lo * so.VAD_SR), int(lo * so.VAD_SR) + len(t)
            stem = os.path.join(out, f"{k:02d} {what} {length:.1f}s {name} at {int(a // 60)}m{a % 60:04.1f}s")
            sf.write(stem + " original.wav", x[i0:i1], so.VAD_SR)
            sf.write(stem + " cleaned.wav", voc[i0:i1] * gain[:len(voc[i0:i1])], so.VAD_SR)
    print(f"{len(chosen)} slips written to {out} (each clip starts 2 s before the slip)")


def cmd_explain(source, at):
    """Like the app's --explain, but reuses the saved vocals when SOURCE is one of your slip cases."""
    source = source if is_link(source) else os.path.abspath(source)
    cached = os.path.join(CACHE, "cases", case_key(source) + ".npz")
    if not os.path.exists(cached):   # old Naqi's app.py --explain is not part of this app
        sys.exit("Not a prepared slip case: add it (benchmark.py add) and run benchmark.py prepare first.")
    with np.load(cached) as z:
        wav16 = z["vocals"].astype(np.float32)
    print(so.old_explain(case_audio(source), so.parse_time(at), wav16=wav16))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("what", nargs="?", default="all", choices=["all", "musan", "smad", "cases"])
    p = sub.add_parser("score")
    p.add_argument("--threshold", type=float)
    p.add_argument("--min-silence", type=int)
    p.add_argument("--pad", type=int)
    p = sub.add_parser("listen")
    p.add_argument("--count", type=int, default=8)
    p.add_argument("--threshold", type=float)
    p.add_argument("--min-silence", type=int)
    p.add_argument("--pad", type=int)
    p = sub.add_parser("tune")
    p.add_argument("--top", type=int, default=15)
    p = sub.add_parser("add")
    p.add_argument("source")
    p.add_argument("start")
    p.add_argument("end")
    p.add_argument("expect")
    p.add_argument("note", nargs="*")
    p = sub.add_parser("explain")
    p.add_argument("source")
    p.add_argument("time")
    a = ap.parse_args()
    if a.cmd == "prepare":
        t0 = time.perf_counter()
        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
        for what, fn in (("musan", prepare_musan), ("smad", prepare_smad), ("cases", prepare_cases)):
            if a.what in ("all", what):
                fn()
        vram = torch.cuda.max_memory_reserved() / 2**20 if torch.cuda.is_available() else 0
        print(f"Prepared in {time.perf_counter() - t0:.0f} s, peak VRAM {vram:.0f} MB")
    elif a.cmd == "score":
        cmd_score((a.threshold, a.min_silence, a.pad))
    elif a.cmd == "listen":
        cmd_listen(a.count, (a.threshold, a.min_silence, a.pad))
    elif a.cmd == "tune":
        cmd_tune(a.top)
    elif a.cmd == "add":
        add_case(a.source, a.start, a.end, a.expect, " ".join(a.note))
    elif a.cmd == "explain":
        cmd_explain(a.source, a.time)


if __name__ == "__main__":
    main()
