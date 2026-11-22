"""Benchmark for the new goal (SPEC R7): remove the music, keep talking, singing and every other sound.
Companion of benchmark.py (which scores the old "talking only" muting). The separators tried are in candidates.py.

Test set: 140 mixes of 30 s (70 min, 44.1 kHz stereo) built from parts that are known one by one, so we know
exactly what must stay and what must go:
  talking   MUSAN speech (already in NAQI_DATA/musan)
  music     MUSDB18 test songs, the instruments alone (drums + bass + other), NAQI_DATA/musdb18/test
  singing   MUSDB18 test songs, the singer's own track
  effects   ESC-50 (dog, rain, footsteps, door, engine, laughing, ...), NAQI_DATA/esc50
Seven kinds of mix: talk over music, film (talk + effects + music), effects over music, song (singing +
instruments), music only, and two without any music (talk + effects, singing alone) to see what gets damaged.

Scores, per 93 ms block and frequency band: the result is explained as "gain x each known part" (least squares),
which tells how much of each part is still in it. Two decoy tracks measure what the fit finds by chance.
  music heard    seconds where left-over music is above -60 dB and less than 30 dB under the kept sounds
  music loud     same with -45 dB and 15 dB (clearly audible)
  lost           seconds where a wanted part (talk / singing / effects) came out more than 6 dB too quiet
  muted          same, more than 20 dB too quiet (gone)

Usage (python -I because the data files are downloaded):
  python -I r7_bench.py build             make the 140 mixes (once; about 2 GB in NAQI_DATA/r7/mixes)
  python -I r7_bench.py run [GROUP ...]   run candidate groups (default: all) and save their scores
  python -I r7_bench.py report            tables from the saved scores
  python -I r7_bench.py real              clean real clips (samples/ and your slip cases) with every candidate,
                                          into NAQI_DATA/r7/listen_real, to judge by ear
"""
import argparse
import csv
import glob
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)   # python -I leaves the script's folder out

import numpy as np
import soundfile as sf
import torch
from scipy.signal import resample_poly

import benchmark as bm
import candidates as cand

DATA = bm.DATA
R7 = os.path.join(DATA, "r7")
SR = cand.SR
MIX_S = 30
N_MIXES = 140
LISTEN_PER_KIND = 2       # this many mixes of each kind are also saved as sound, to listen to
KINDS = ["talk over music", "film: talk + effects + music", "effects over music", "song: singing + instruments",
         "music only", "no music: talk + effects", "no music: singing alone"]
PARTS = ["speech", "sing", "fx", "music"]
PART_NAMES = {"speech": "talk", "sing": "singing", "fx": "effects"}
FX_SKIP = {"clapping", "church_bells"}   # unclear under R7 (hand claps / bells count as instruments)

NFFT, HOP, TB = 2048, 512, 8             # scoring grid: 8 frames = 93 ms blocks
BLOCK_S = TB * HOP / SR
BAND_HZ = [0, 100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270, 1480, 1720, 2000, 2320, 2700, 3150, 3700, 4400,
           5300, 6400, 7700, 9500, 12000, 15500, 22050]
PRESENT_DB = {"music": -50, "speech": -45, "sing": -45, "fx": -50}   # a part counts as "there" above this level
HEARD_DB, HEARD_UNDER_DB = -60, 30
LOUD_DB, LOUD_UNDER_DB = -45, 15
LOST_DB, MUTED_DB = -6, -20


# ---------- building the mixes ----------

def read_audio(path, start, dur, stream=None):
    """(2, n) float32 at 44.1 kHz. stream: which audio track of a MUSDB file (1 drums, 2 bass, 3 other, 4 vocals)."""
    cmd = ["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", path]
    if stream is not None:
        cmd += ["-map", f"0:a:{stream}"]
    raw = subprocess.run(cmd + ["-f", "f32le", "-ac", "2", "-ar", str(SR), "pipe:1"], capture_output=True,
                         stdin=subprocess.DEVNULL).stdout
    x = np.frombuffer(raw, np.float32).reshape(-1, 2).T
    out = np.zeros((2, int(dur * SR)), np.float32)
    out[:, :x.shape[1]] = x[:, :out.shape[1]]
    return out


def active_db(x):
    """Loudness (dB) of the non-silent part of x."""
    db = bm.frame_db(x.mean(0) if x.ndim == 2 else x, SR)
    on = db > max(db.max() - 35, -55)
    return 10 * np.log10(np.mean(10 ** (db[on] / 10)) + 1e-10) if on.any() else -100.0


def song_window(rng, songs, need_singing):
    """A 30 s piece of a song: (instruments, singer). With need_singing, the piece where the singer is most present."""
    best = None
    for _ in range(6):
        song = songs[rng.integers(len(songs))]
        start = rng.uniform(10, max(11, so_duration(song) - MIX_S - 10))
        voc = read_audio(song, start, MIX_S, 4)
        db = bm.frame_db(voc.mean(0), SR)
        score = (db > -45).mean() if need_singing else rng.random()
        if best is None or score > best[0]:
            best = (score, song, start, voc)
        if not need_singing or score > 0.6:
            break
    _, song, start, voc = best
    music = sum(read_audio(song, start, MIX_S, s) for s in (1, 2, 3))
    return music, voc, os.path.basename(song)


_durations = {}


def so_duration(path):
    if path not in _durations:
        _durations[path] = bm.so.duration_of(path)
    return _durations[path]


def speech_track(rng, speech_files):
    """Talking with pauses (so there are music-only moments too), mono, about -23 dB while speaking."""
    out = np.zeros(MIX_S * SR, np.float32)
    t = rng.uniform(0.5, 3)
    while True:
        x, act, _ = bm.speech_chunk(rng, speech_files)
        if t + len(x) / bm.MIX_SR > MIX_S - 0.5:
            break
        x = resample_poly(x, SR, bm.MIX_SR).astype(np.float32)
        x *= 10 ** ((bm.SPEECH_DB - active_db(x)) / 20)
        a = int(t * SR)
        out[a:a + len(x)] = x[:len(out) - a]
        t += len(x) / SR + rng.uniform(1, 5)
    return out


def fx_track(rng, fx_files):
    """Sound effects one after another with short gaps, mono, each 0-12 dB quieter than the talking."""
    out = np.zeros(MIX_S * SR, np.float32)
    t = rng.uniform(0.3, 2.5)
    while t < MIX_S - 5.5:
        x, sr = sf.read(fx_files[rng.integers(len(fx_files))], dtype="float32")
        x = x if x.ndim == 1 else x.mean(1)
        if sr != SR:
            x = resample_poly(x, SR, sr).astype(np.float32)
        level = active_db(x)
        if level < -70:
            continue
        x = x * 10 ** ((bm.SPEECH_DB - rng.uniform(0, 12) - level) / 20)
        a = int(t * SR)
        out[a:a + len(x)] += x[:len(out) - a]
        t += len(x) / SR + rng.uniform(0.3, 3)
    return out


def sources():
    songs = sorted(glob.glob(os.path.join(DATA, "musdb18", "test", "*.stem.mp4")))
    with open(os.path.join(DATA, "esc50", "ESC-50-master", "meta", "esc50.csv"), encoding="utf-8") as f:
        fx = sorted(os.path.join(DATA, "esc50", "ESC-50-master", "audio", r["filename"])
                    for r in csv.DictReader(f) if r["category"] not in FX_SKIP)
    speech = bm.musan_pools()[2]
    if not (songs and fx and speech):
        sys.exit("Test sounds missing: need MUSAN speech, MUSDB18 test songs and ESC-50 in " + DATA)
    return songs, fx, speech


def build_mix(i, src):
    """Mix number i (always the same for the same i): {part: (2, n)} of the parts it is made of, kind, note."""
    songs, fx_files, speech_files = src
    rng = np.random.default_rng(7000 + i)
    kind = i % len(KINDS)
    level = bm.LEVELS[(i // len(KINDS)) % len(bm.LEVELS)]
    parts, note = {}, ""
    if kind in (0, 1, 5):
        parts["speech"] = np.tile(speech_track(rng, speech_files), (2, 1))
    if kind in (1, 2, 5):
        parts["fx"] = np.tile(fx_track(rng, fx_files), (2, 1))
    if kind in (0, 1, 2, 4):
        music, _, song = song_window(rng, songs, False)
        # talk/effects are `level` dB louder than the music (negative = music louder); music only: normal level
        parts["music"] = music * 10 ** ((bm.SPEECH_DB - (level if kind != 4 else 0) - active_db(music)) / 20)
        note = f"{song}, music {-level:+d} dB" if kind != 4 else song
    if kind in (3, 6):
        music, voc, song = song_window(rng, songs, True)
        gain = 10 ** ((bm.SPEECH_DB - active_db(voc)) / 20)   # the song's own balance is kept
        parts["sing"] = voc * gain
        if kind == 3:
            parts["music"] = music * gain
        note = song
    peak = np.abs(sum(parts.values())).max()
    if peak > 0.99:
        parts = {k: v * (0.99 / peak) for k, v in parts.items()}
    return parts, KINDS[kind], note


def mix_path(i):
    return os.path.join(R7, "mixes", f"mix{i:03d}.npz")


def cmd_build():
    src = sources()
    os.makedirs(os.path.join(R7, "mixes"), exist_ok=True)
    for i in range(N_MIXES):
        if os.path.exists(mix_path(i)):
            continue
        parts, kind, note = build_mix(i, src)
        tmp = mix_path(i)[:-4] + ".tmp.npz"
        np.savez(tmp, kind=kind, note=note, **{k: v.astype(np.float16) for k, v in parts.items()})
        os.replace(tmp, mix_path(i))
        print(f"  mix {i + 1}/{N_MIXES}: {kind} ({note})", flush=True)


def load_mix(i):
    with np.load(mix_path(i)) as z:
        parts = {k: torch.from_numpy(z[k].astype(np.float32)).to(cand.DEV) for k in PARTS if k in z}
        return parts, str(z["kind"]), str(z["note"])


# ---------- scoring ----------

_win = None


def _spec(x):
    global _win
    if _win is None or _win.device != x.device:
        _win = torch.hann_window(NFFT, device=x.device)
    return torch.stft(x, NFFT, HOP, window=_win, return_complex=True)


def analyse(est, parts):
    """How loud each known part is in the mix and in the result: {part: (in, out)} power per 93 ms block."""
    names = list(parts)
    Y = _spec(est)
    specs = [_spec(parts[k]) for k in names]
    if "music" in parts:
        # Two decoys (the same music moved 7 s, and played backwards) have nothing to do with the result, so
        # whatever the fit gives them is chance. That much is taken off the real music's share.
        specs += [_spec(torch.roll(parts["music"], 7 * SR + 1234, -1)), _spec(torch.flip(parts["music"], (-1,)))]
    S = torch.stack(specs)                                      # (K, 2, F, T)
    nblk = Y.shape[-1] // TB
    Y, S = Y[..., :nblk * TB], S[..., :nblk * TB]
    K = len(specs)
    e_in = torch.zeros(K, nblk, device=est.device)
    e_out = torch.zeros(K, nblk, device=est.device)
    eye = torch.eye(K, device=est.device)
    bins = [int(round(hz * NFFT / SR)) for hz in BAND_HZ]
    for lo, hi in zip(bins[:-1], bins[1:]):
        # one least-squares fit per block: result = sum of gain_k * part_k over this band's bins, frames, channels
        a = S[:, :, lo:hi].reshape(K, 2, hi - lo, nblk, TB).permute(3, 0, 1, 2, 4).reshape(nblk, K, -1)
        y = Y[:, lo:hi].reshape(2, hi - lo, nblk, TB).permute(2, 0, 1, 3).reshape(nblk, -1)
        energy = a.abs().pow(2).sum(-1)                          # (nblk, K)
        d = (energy + 1e-9).sqrt()
        g = torch.einsum("bkm,bjm->bkj", a.conj(), a) / (d[:, :, None] * d[:, None, :]) + 1e-6 * eye
        r = torch.einsum("bkm,bm->bk", a.conj(), y) / d
        gain = torch.linalg.solve(g, r.unsqueeze(-1)).squeeze(-1)
        e_in += energy.T
        e_out += (gain.abs().pow(2) * energy / (energy + 1e-9)).T
    if "music" in parts:
        j = names.index("music")
        e_out[j] = (e_out[j] - torch.maximum(e_out[-1], e_out[-2])).clamp(min=0)
    scale = 1.0 / (NFFT * _win.pow(2).sum().item() * TB)        # to mean-square per sample
    return {k: ((e_in[j] * scale).cpu().numpy(), (e_out[j] * scale).cpu().numpy()) for j, k in enumerate(names)}


def db(x):
    return 10 * np.log10(x + 1e-12)


def score(est, parts):
    """One row of sums (seconds and energies) for one result."""
    lv = analyse(est, parts)
    n = len(next(iter(lv.values()))[0])
    keep = [k for k in parts if k != "music"]
    keep_out = sum(lv[k][1] for k in keep) if keep else np.zeros(n)
    keep_there = np.zeros(n, bool)
    row = {}
    for k in keep:
        e_in, e_out = lv[k]
        there = db(e_in) > PRESENT_DB[k]
        keep_there |= there
        change = db(e_out) - db(e_in)
        row[k + "_s"] = there.sum() * BLOCK_S
        row[k + "_lost_s"] = (there & (change < LOST_DB)).sum() * BLOCK_S
        row[k + "_muted_s"] = (there & (change < MUTED_DB)).sum() * BLOCK_S
    if "music" in parts:
        e_in, e_out = lv["music"]
        there = db(e_in) > PRESENT_DB["music"]
        heard = there & (db(e_out) > HEARD_DB) & (db(e_out) > db(keep_out) - HEARD_UNDER_DB)
        loud = there & (db(e_out) > LOUD_DB) & (db(e_out) > db(keep_out) - LOUD_UNDER_DB)
        row.update(music_s=there.sum() * BLOCK_S, heard_s=heard.sum() * BLOCK_S, loud_s=loud.sum() * BLOCK_S,
                   alone_s=(there & ~keep_there).sum() * BLOCK_S,
                   alone_heard_s=(heard & ~keep_there).sum() * BLOCK_S,
                   under_s=(there & keep_there).sum() * BLOCK_S,
                   under_heard_s=(heard & keep_there).sum() * BLOCK_S,
                   music_in_e=float(e_in[there].sum()), music_out_e=float(e_out[there].sum()))
    if keep:
        target = sum(parts[k] for k in keep)
        n_ = min(target.shape[-1], est.shape[-1])
        err = (est[:, :n_] - target[:, :n_]).pow(2).sum().item()
        row["sdr"] = 10 * np.log10(target.pow(2).sum().item() / (err + 1e-12))
    return {k: float(v) for k, v in row.items()}


# ---------- running the candidates ----------

def slug(name):
    return "".join(c if c.isalnum() or c in " +-" else "" for c in name).strip()


def cmd_run(groups):
    if not os.path.exists(mix_path(N_MIXES - 1)):
        sys.exit("Mixes not built yet: run 'python -I r7_bench.py build' first.")
    os.makedirs(os.path.join(R7, "results"), exist_ok=True)
    for name in groups or list(cand.GROUPS):
        load, run, uses = cand.GROUPS[name]
        models = load()
        run(models, load_mix(0)[0]["speech"], cand.Stages())   # warm-up, not timed
        if cand.DEV == "cuda":
            torch.cuda.empty_cache()
            torch.cuda.reset_peak_memory_stats()
        stages = cand.Stages()
        rows = {p: [] for p in uses}
        t0 = time.perf_counter()
        for i in range(N_MIXES):
            parts, kind, note = load_mix(i)
            mix = sum(parts.values())
            results = run(models, mix, stages)
            listen = None
            if i // len(KINDS) < LISTEN_PER_KIND:
                listen = os.path.join(R7, "listen", f"mix{i:03d} {kind.replace(':', '')}")
                os.makedirs(listen, exist_ok=True)
                sf.write(os.path.join(listen, "0 original.flac"), mix.T.cpu().numpy(), SR)
            for p, est in results.items():
                rows[p].append(dict(score(est, parts), mix=i, kind=kind))
                if listen:
                    sf.write(os.path.join(listen, slug(p) + ".flac"), est.T.clamp(-1, 1).cpu().numpy(), SR)
            print(f"  {name}: mix {i + 1}/{N_MIXES} ({time.perf_counter() - t0:.0f} s)", flush=True)
        vram = torch.cuda.max_memory_reserved() / 2**20 if cand.DEV == "cuda" else 0
        per_call = {s: stages.seconds[s] / stages.calls[s] for s in stages.seconds}
        out = {"device": cand.DEV, "vram_mb": vram, "mix_s": MIX_S, "stage_s_per_mix": per_call,
               "pipelines": {p: {"stages": uses[p], "rows": rows[p]} for p in uses}}
        with open(os.path.join(R7, "results", name + ".json"), "w", encoding="utf-8") as f:
            json.dump(out, f)
        print(f"{name}: done, peak VRAM {vram:.0f} MB, seconds per 30 s mix: "
              + ", ".join(f"{s} {v:.2f}" for s, v in per_call.items()), flush=True)
        del models


# ---------- report ----------

def pct(a, b):
    return f"{100 * a / b:4.0f}%" if b else "   - "


def total(rows, key):
    return sum(r.get(key, 0.0) for r in rows)


def line(label, rows):
    out = f"  {label:30} {total(rows, 'music_s') / 60:5.1f}m | "
    out += (f"{pct(total(rows, 'heard_s'), total(rows, 'music_s'))} {pct(total(rows, 'loud_s'), total(rows, 'music_s'))} "
            f"{pct(total(rows, 'alone_heard_s'), total(rows, 'alone_s'))} "
            f"{pct(total(rows, 'under_heard_s'), total(rows, 'under_s'))} ")
    m_in, m_out = total(rows, "music_in_e"), total(rows, "music_out_e")
    out += f"{10 * np.log10(m_out / m_in + 1e-12):5.0f} dB |" if m_in else "    -    |"
    for k in ("speech", "sing", "fx"):
        out += (f" {pct(total(rows, k + '_lost_s'), total(rows, k + '_s'))} "
                f"{pct(total(rows, k + '_muted_s'), total(rows, k + '_s'))} |")
    sdr = [r["sdr"] for r in rows if "sdr" in r]
    return out + (f" {np.median(sdr):5.1f} dB" if sdr else "")


def cmd_report():
    files = sorted(glob.glob(os.path.join(R7, "results", "*.json")))
    if not files:
        sys.exit("No results yet: run 'python -I r7_bench.py run' first.")
    summary = []
    print("music heard = left-over music you could hear (% of the time music plays); loud = clearly audible;\n"
          "alone = while nothing else sounds; under = under talk/singing/effects; cut = how much quieter the music got.\n"
          "lost = came out more than 6 dB too quiet (% of its time); muted = more than 20 dB (gone).\n"
          "quality = how close the result is to the perfect one (dB, higher is better).")
    head = (f"  {'kind of mix':30} {'music':>6} | {'heard':>5} {'loud':>5} {'alone':>5} {'under':>5} {'cut':>8} |"
            f" {'talk lost/muted':>11} | {'sing lost/muted':>11} | {'fx lost/muted':>11} | quality")
    for f in files:
        with open(f, encoding="utf-8") as fh:
            res = json.load(fh)
        for p, d in res["pipelines"].items():
            rows = d["rows"]
            seconds = sum(res["stage_s_per_mix"][s] for s in d["stages"])
            speed = res["mix_s"] / seconds
            print(f"\n{p}   ({speed:.1f}x realtime on {res['device']}, 5 min video in {300 / speed:.0f} s; "
                  f"peak VRAM of its group {res['vram_mb']:.0f} MB)")
            print(head)
            for kind in KINDS:
                print(line(kind, [r for r in rows if r["kind"] == kind]))
            print(line("ALL", rows))
            summary.append((p, rows, speed, res["vram_mb"]))
    print("\nSummary (all 140 mixes)")
    print(f"  {'candidate':42} | {'music heard':>11} {'loud':>5} | {'talk lost':>9} | {'singing lost':>12} | "
          f"{'effects lost':>12} | {'5 min video':>11} | {'VRAM':>7}")
    for p, rows, speed, vram in summary:
        print(f"  {p:42} | {pct(total(rows, 'heard_s'), total(rows, 'music_s')):>11} "
              f"{pct(total(rows, 'loud_s'), total(rows, 'music_s'))} | "
              f"{pct(total(rows, 'speech_lost_s'), total(rows, 'speech_s')):>9} | "
              f"{pct(total(rows, 'sing_lost_s'), total(rows, 'sing_s')):>12} | "
              f"{pct(total(rows, 'fx_lost_s'), total(rows, 'fx_s')):>12} | {300 / speed:9.0f} s | {vram:4.0f} MB")


# ---------- real clips, to judge by ear ----------

def cmd_real(groups):
    """60 s of each clip in samples/ and 30 s around each of your slip cases, cleaned by every candidate."""
    out = os.path.join(R7, "listen_real")
    clips = [(os.path.splitext(os.path.basename(f))[0], f, 60.0, 60.0)
             for f in sorted(glob.glob(os.path.join(HERE, "..", "samples", "*")))]
    for c in bm.read_cases():
        start = max(0.0, bm.so.parse_time(c["start"]) - 10)
        clips.append((f"slip case at {c['start'].replace(':', 'm')}", bm.case_audio(c["source"]), start, 30.0))
    for name in groups or list(cand.GROUPS):
        load, run, _ = cand.GROUPS[name]
        models = load()
        for label, path, start, dur in clips:
            folder = os.path.join(out, label)
            os.makedirs(folder, exist_ok=True)
            mix = torch.from_numpy(read_audio(path, start, dur).copy()).to(cand.DEV)
            sf.write(os.path.join(folder, "0 original.flac"), mix.T.cpu().numpy(), SR)
            for p, est in run(models, mix, cand.Stages()).items():
                sf.write(os.path.join(folder, slug(p) + ".flac"), est.T.clamp(-1, 1).cpu().numpy(), SR)
        del models
        print(f"{name}: {len(clips)} clips written to {out}", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("build")
    for c in ("run", "real"):
        sub.add_parser(c).add_argument("groups", nargs="*", help="any of: " + ", ".join(cand.GROUPS))
    sub.add_parser("report")
    a = ap.parse_args()
    if a.cmd == "build":
        cmd_build()
    elif a.cmd == "run":
        cmd_run(a.groups)
    elif a.cmd == "real":
        cmd_real(a.groups)
    else:
        cmd_report()


if __name__ == "__main__":
    main()
