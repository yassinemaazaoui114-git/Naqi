"""Separator candidates for the new goal (SPEC R7): remove the music, keep talking, singing and all other sounds.
Benchmark only, the app does not use this file. Used by r7_bench.py. The group "app" runs the app's own code
(speech_only.py), the other groups are the candidates that were tried on the way.

A "group" loads its models once and returns several results ("pipelines") for one mix, so shared work runs once.
Each model call is timed as a "stage"; a pipeline's time is the sum of the stages it needs.

Model files and code live outside the project, in NAQI_DATA (default %USERPROFILE%\\Naqi-data):
  models/97d170e1-*.th         Demucs trained on film audio (DnR), github.com/ZFTurbo/MVSEP-CDX23-Cinematic-Sound-Demixing (MIT)
  models/bandit_v2_multi.ckpt  Bandit v2, zenodo.org/records/12701995 (CC BY-SA 4.0)
  models/MelBandRoformer.ckpt  Mel-Band Roformer vocals, huggingface.co/KimberleyJSN/melbandroformer
  code/MSST                    model code: github.com/ZFTurbo/Music-Source-Separation-Training (MIT)
Extra libraries (benchmark only): librosa, pytorch-lightning, rotary-embedding-torch, beartype.
"""
import os
import sys
import time

import numpy as np
import torch
import yaml
from demucs.apply import apply_model
from torchaudio.functional import resample

import speech_only as so

DATA = os.environ.get("NAQI_DATA") or os.path.join(os.path.expanduser("~"), "Naqi-data")
MODELS = os.path.join(DATA, "models")
MSST = os.path.join(DATA, "code", "MSST")
SR = so.SR
DEV = "cuda" if torch.cuda.is_available() else "cpu"


class Stages:
    """Seconds spent in each model, and how often it was called."""
    def __init__(self):
        self.seconds, self.calls = {}, {}

    def run(self, name, fn, *args):
        if DEV == "cuda":
            torch.cuda.synchronize()
        t0 = time.perf_counter()
        out = fn(*args)
        if DEV == "cuda":
            torch.cuda.synchronize()
        self.seconds[name] = self.seconds.get(name, 0.0) + time.perf_counter() - t0
        self.calls[name] = self.calls.get(name, 0) + 1
        return out


def demucs_stems(model, x):
    """x: (2, n) -> {source name: (2, n)}. Same normalisation and settings as the app (speech_only._vocals)."""
    ref = x.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    with torch.no_grad():
        out = apply_model(model, ((x - mean) / std)[None], device=DEV, shifts=0, split=True,
                          overlap=so.OVERLAP, progress=False)[0]
    return {name: out[i] * std + mean for i, name in enumerate(model.sources)}


def chunked(fn, x, chunk, n_stems, batch=2, fade=None):
    """Run fn on overlapping pieces of x (2, n) and cross-fade them. fn: (b, 2, chunk) -> (b, n_stems, 2, chunk).
    fade = samples two neighbouring pieces share (default half a piece, so every sample is computed twice)."""
    fade = fade or chunk // 2
    hop = chunk - fade
    n = x.shape[-1]
    pad = fade + (-(n + fade)) % hop
    x = torch.nn.functional.pad(x, (fade, pad))
    ramp = torch.hann_window(2 * fade, periodic=True, device=x.device)
    win = torch.ones(chunk, device=x.device)   # flat middle, ramps that add up to a constant 1 where pieces overlap
    win[:fade], win[-fade:] = ramp[:fade], ramp[fade:]
    out = torch.zeros(n_stems, 2, x.shape[-1], device=x.device)
    starts = list(range(0, x.shape[-1] - chunk + 1, hop))
    for i in range(0, len(starts), batch):
        part = starts[i:i + batch]
        with torch.no_grad():
            y = fn(torch.stack([x[:, s:s + chunk] for s in part])).float()
        for s, yy in zip(part, y):
            out[:, :, s:s + chunk] += yy * win
    return out[:, :, fade:fade + n]


def vad_gain(vocals):
    """What the app does after Demucs: 0..1 gain per sample that mutes everything Silero VAD does not call speech."""
    wav16 = resample(vocals.mean(0), SR, so.VAD_SR).cpu()
    parts = so.parts_from_probs(so.vad_probs(wav16), len(wav16))
    xs = [p for a, b in parts for p in (a - so.FADE_S, a, b, b + so.FADE_S)]
    ys = [0.0, 1.0, 1.0, 0.0] * len(parts)
    t = np.arange(vocals.shape[-1]) / SR
    gain = np.interp(t, xs, ys, left=0.0, right=0.0) if parts else np.zeros_like(t)
    return torch.from_numpy(gain.astype(np.float32)).to(vocals.device)


# ---------- model loaders ----------

def load_htdemucs():
    return so.old_models()[0].to(DEV)


def load_film_demucs():
    from demucs.states import load_model
    return load_model(os.path.join(MODELS, "97d170e1-dbb4db15.th")).eval().to(DEV)   # sources: music, sfx, speech


def _msst():
    if MSST not in sys.path:
        sys.path.insert(0, MSST)


class Bandit:
    """Bandit v2 (multilingual DnR v3 weights): speech / music / sfx. Works at 48 kHz, one channel at a time."""
    FS, CHUNK = 48000, 384000

    def __init__(self):
        _msst()
        from models.bandit_v2.bandit import Bandit as Net
        with open(os.path.join(MSST, "configs", "config_dnr_bandit_v2_mus64.yaml")) as f:
            kwargs = yaml.load(f, Loader=yaml.UnsafeLoader)["kwargs"]   # our own copy of the MSST config
        self.net = Net(fs=self.FS, **kwargs)
        state = torch.load(os.path.join(MODELS, "bandit_v2_multi.ckpt"), map_location="cpu",
                           weights_only=False)["state_dict"]
        state = {k[len("model."):]: v for k, v in state.items() if k.startswith("model.")}
        self.net.load_state_dict(state, strict=True)
        self.net.eval().to(DEV)
        self.stems = list(self.net.stems)

    def _fn(self, b):
        with torch.autocast("cuda", dtype=torch.float16, enabled=DEV == "cuda"):   # measured: 11x vs 7x realtime
            return self.net(b)

    def __call__(self, x, fade=None):
        y = chunked(self._fn, resample(x, SR, self.FS), self.CHUNK, len(self.stems), fade=fade)
        y = resample(y, self.FS, SR)[..., :x.shape[-1]]
        return dict(zip(self.stems, y))

    def _sfx_fn(self, b):
        """Effects only, in one pass: the model listens to left+right mixed together, and its "this is an effect"
        mask is then put on the left and right channel each (normal use runs the whole model once per channel)."""
        net, n = self.net, b.shape[-1]
        with torch.autocast("cuda", dtype=torch.float16, enabled=DEV == "cuda"):
            mono = net.stft(b.mean(1, keepdim=True))                    # (b, 1, freq, time)
            m = net.mask_estim["sfx"](net.tf_model(net.band_split(mono))).to(mono.dtype)
            lr = net.stft(b.reshape(-1, 1, n))                          # (2b, 1, freq, time)
            s = torch.reshape(lr * m.repeat_interleave(2, 0), lr.shape)
            return net.istft(s, n).reshape(b.shape)[:, None]

    def sfx_one_pass(self, x, fade=None):
        y = chunked(self._sfx_fn, resample(x, SR, self.FS), self.CHUNK, 1, fade=fade)
        return resample(y, self.FS, SR)[0, :, :x.shape[-1]]


class Roformer:
    """Mel-Band Roformer (Kimberley Jensen): the voice (talking or singing) of a mix."""
    CHUNK = 352800

    def __init__(self):
        _msst()
        from models.bs_roformer import MelBandRoformer
        with open(os.path.join(MSST, "configs", "KimberleyJensen", "config_vocals_mel_band_roformer_kj.yaml")) as f:
            cfg = yaml.load(f, Loader=yaml.UnsafeLoader)["model"]
        self.net = MelBandRoformer(**cfg)
        self.net.load_state_dict(torch.load(os.path.join(MODELS, "MelBandRoformer.ckpt"), map_location="cpu"))
        self.net.eval().to(DEV)

    def _fn(self, b):
        with torch.autocast("cuda", dtype=torch.float16, enabled=DEV == "cuda"):   # 6x vs 3x realtime
            return self.net(b)[:, None]

    def __call__(self, x, fade=None):
        return chunked(self._fn, x, self.CHUNK, 1, batch=1, fade=fade)[0]


# ---------- groups: name -> (loader, run(models, mix, stages) -> {pipeline: result}, {pipeline: stages used}) ----------

def _g_demucs():
    return load_htdemucs()


def _r_demucs(m, mix, st):
    s = st.run("demucs", demucs_stems, m, mix)
    return {
        "Demucs: voice only": s["vocals"],
        "App today (Demucs voice + talk detector)": s["vocals"] * st.run("vad", vad_gain, s["vocals"]),
        "Demucs: voice + 'other'": s["vocals"] + s["other"],
    }


def _g_film():
    return load_film_demucs(), load_htdemucs()


def _r_film(m, mix, st):
    film, ht = m
    s = st.run("film-demucs", demucs_stems, film, mix)
    sing = st.run("demucs", demucs_stems, ht, s["music"])["vocals"]
    return {
        "Film-Demucs: voice + effects": s["speech"] + s["sfx"],
        "Film-Demucs + singing rescue (Demucs)": s["speech"] + s["sfx"] + sing,
    }


def _g_bandit():
    return Bandit(), load_htdemucs()


def _r_bandit(m, mix, st):
    bandit, ht = m
    s = st.run("bandit", bandit, mix)
    sing = st.run("demucs", demucs_stems, ht, s["music"])["vocals"]
    return {
        "Bandit v2: voice + effects": s["speech"] + s["sfx"],
        "Bandit v2 + singing rescue (Demucs)": s["speech"] + s["sfx"] + sing,
    }


def _g_roformer():
    return Bandit(), Roformer()


def _r_roformer(m, mix, st):
    bandit, rofo = m
    s = st.run("bandit", bandit, mix)
    sing = st.run("roformer", rofo, s["music"])
    voice = st.run("roformer", rofo, mix)
    rest = st.run("bandit", bandit, mix - voice)
    return {
        "Bandit v2 + singing rescue (Roformer)": s["speech"] + s["sfx"] + sing,
        "Roformer voice + Bandit v2 effects": voice + rest["sfx"],
    }


FADE_S = 1.0   # "short joins": neighbouring 8 s pieces share 1 s instead of 4 s


def _r_fast(m, mix, st):
    """Speed-ups of "Roformer voice + Bandit v2 effects" (SPEC R7c)."""
    bandit, rofo = m
    voice = st.run("roformer-short", rofo, mix, int(FADE_S * SR))
    rest = mix - voice
    sfx = st.run("bandit-short", bandit, rest, int(FADE_S * Bandit.FS))["sfx"]
    sfx1 = st.run("bandit-one-pass", bandit.sfx_one_pass, rest, int(FADE_S * Bandit.FS))
    return {
        "Fast: short joins": voice + sfx,
        "Fast: short joins + one-pass Bandit": voice + sfx1,
    }


def _g_app():
    so.warm_up()


def _r_app(m, mix, st):
    """What the app does (speech_only.remove_music), in its two steps."""
    voice, effects = st.run("app-separate", so.separate, mix, DEV)
    return {
        "App v5 without the music-trace muting": voice + effects,
        "App v5 (Roformer + Bandit + music-trace muting)": st.run("app-trace", so.mute_traces, mix, voice + effects)[0],
    }


GROUPS = {
    "app": (_g_app, _r_app, {
        "App v5 without the music-trace muting": ["app-separate"],
        "App v5 (Roformer + Bandit + music-trace muting)": ["app-separate", "app-trace"]}),
    "demucs": (_g_demucs, _r_demucs, {
        "Demucs: voice only": ["demucs"],
        "App today (Demucs voice + talk detector)": ["demucs", "vad"],
        "Demucs: voice + 'other'": ["demucs"]}),
    "film": (_g_film, _r_film, {
        "Film-Demucs: voice + effects": ["film-demucs"],
        "Film-Demucs + singing rescue (Demucs)": ["film-demucs", "demucs"]}),
    "bandit": (_g_bandit, _r_bandit, {
        "Bandit v2: voice + effects": ["bandit"],
        "Bandit v2 + singing rescue (Demucs)": ["bandit", "demucs"]}),
    "roformer": (_g_roformer, _r_roformer, {
        "Bandit v2 + singing rescue (Roformer)": ["bandit", "roformer"],
        "Roformer voice + Bandit v2 effects": ["roformer", "bandit"]}),
    "fast": (_g_roformer, _r_fast, {
        "Fast: short joins": ["roformer-short", "bandit-short"],
        "Fast: short joins + one-pass Bandit": ["roformer-short", "bandit-one-pass"]}),
}
