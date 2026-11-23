"""CPU-only speed options (ROADMAP T8.2): time each option on the same clip and compare its sound with the plain
CPU result and the GPU result. The engine is not changed; each option is tried here only.
Usage: py -3.12 bench/cpu_speed.py [clip] [option ...]   (default clip: samples/narration_30s.mp3, all options)
Results: test_out/t8.2/<option>.json (+ a GPU reference wav, made once).
"""
import json
import os
import sys
import time

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(HERE, "engine"))

import numpy as np  # noqa: E402
import torch  # noqa: E402
from torchaudio.functional import resample  # noqa: E402

import speech_only as so  # noqa: E402

OUT = os.path.join(HERE, "test_out", "t8.2")


def load(path):
    mix = np.concatenate([m for m, lead, n in so._blocks(path, 10_000, lambda: False)])
    return torch.from_numpy(mix.T.copy())


def run(x, device, voice_net, effects_net, batch_v=1, batch_e=2, dtype=None):
    """Same steps as speech_only.separate + mute_traces, with the options; returns (out, muted, voice_s, effects_s)."""
    cast = dict(device_type=device, dtype=dtype or torch.float16, enabled=dtype is not None)

    def voice_fn(b):
        with torch.autocast(**cast):
            return voice_net(b)

    def effects_fn(b):
        net, n = effects_net, b.shape[-1]
        with torch.autocast(**cast):
            mono = net.stft(b.mean(1, keepdim=True))
            m = net.mask_estim["sfx"](net.tf_model(net.band_split(mono))).to(mono.dtype)
            lr = net.stft(b.reshape(-1, 1, n))
            s = torch.reshape(lr * m.repeat_interleave(2, 0), lr.shape)
            return net.istft(s, n).reshape(b.shape)

    sync = torch.cuda.synchronize if device == "cuda" else (lambda: None)
    n = x.shape[-1]
    t0 = time.perf_counter()
    voice = so._pieces(voice_fn, x, so.PIECE_S * so.SR, so.JOIN_S * so.SR, batch_v, lambda f: None)
    sync()
    t1 = time.perf_counter()
    rest = resample(x - voice, so.SR, so.BANDIT_SR)
    effects = so._pieces(effects_fn, rest, so.PIECE_S * so.BANDIT_SR, so.JOIN_S * so.BANDIT_SR, batch_e,
                         lambda f: None)
    effects = resample(effects, so.BANDIT_SR, so.SR)[:, :n]
    sync()
    t2 = time.perf_counter()
    out, keep = so.mute_traces(x, voice + effects)
    return out.float().cpu(), (1.0 - keep).float().cpu(), t1 - t0, t2 - t1


def snr(ref, y):
    """How close y is to ref, in dB (higher = closer; 40 dB = the difference is 1% of the sound's level)."""
    return float(10 * torch.log10(ref.pow(2).sum() / ((ref - y).pow(2).sum() + 1e-12)))


def quantized(voice_net, effects_net):
    q = torch.ao.quantization.quantize_dynamic
    return (q(voice_net, {torch.nn.Linear}, dtype=torch.qint8),
            q(effects_net, {torch.nn.Linear, torch.nn.GRU, torch.nn.LSTM}, dtype=torch.qint8))


OPTIONS = {   # name: (threads, batch_v, batch_e, dtype, quantize)
    "base": (None, 1, 2, None, False),          # what the engine does today on the CPU
    "t4": (4, 1, 2, None, False),
    "t8": (8, 1, 2, None, False),
    "t16": (16, 1, 2, None, False),
    "batch4": (None, 4, 4, None, False),
    "t16b4": (16, 4, 4, None, False),
    "bf16": (None, 1, 2, torch.bfloat16, False),
    "int8": (None, 1, 2, None, True),
}


def main():
    args = sys.argv[1:]
    clip = args.pop(0) if args and os.path.exists(args[0]) else os.path.join(HERE, "samples", "narration_30s.mp3")
    names = args or list(OPTIONS)
    os.makedirs(OUT, exist_ok=True)
    x = load(clip)
    length = x.shape[-1] / so.SR
    tag = os.path.splitext(os.path.basename(clip))[0]
    voice_net, effects_net = so._models()

    gpu_ref = os.path.join(OUT, f"{tag}_gpu.pt")
    if not os.path.exists(gpu_ref) and torch.cuda.is_available():
        out, muted, vs, es = run(x.cuda(), "cuda", voice_net.cuda(), effects_net.cuda(), dtype=torch.float16)
        torch.save({"out": out, "muted": muted}, gpu_ref)
        voice_net.cpu(), effects_net.cpu()
        print(f"gpu reference: voice {vs:.1f}s effects {es:.1f}s")
    gpu = torch.load(gpu_ref) if os.path.exists(gpu_ref) else None
    cpu_ref = os.path.join(OUT, f"{tag}_base.pt")

    default_threads = torch.get_num_threads()
    for name in names:
        threads, bv, be, dtype, quant = OPTIONS[name]
        torch.set_num_threads(threads or default_threads)
        vn, en = quantized(voice_net, effects_net) if quant else (voice_net, effects_net)
        run(x[:, :so.SR * 9], "cpu", vn, en, bv, be, dtype)   # warm-up
        t = time.perf_counter()
        out, muted, vs, es = run(x, "cpu", vn, en, bv, be, dtype)
        total = time.perf_counter() - t
        if name == "base":
            torch.save({"out": out, "muted": muted}, cpu_ref)
        base = torch.load(cpu_ref) if os.path.exists(cpu_ref) else None
        r = {"option": name, "clip": tag, "length_s": round(length, 1), "threads": torch.get_num_threads(),
             "seconds": round(total, 1), "speed_x": round(length / total, 3),
             "voice_s": round(vs, 1), "effects_s": round(es, 1), "muted_pct": round(float(muted.mean()) * 100, 1)}
        if base is not None:
            r["snr_vs_cpu_db"] = round(snr(base["out"], out), 1)
            r["muted_diff_vs_cpu_pct"] = round(float((base["muted"] - muted).abs().mean()) * 100, 2)
        if gpu is not None:
            r["snr_vs_gpu_db"] = round(snr(gpu["out"], out), 1)
            r["muted_diff_vs_gpu_pct"] = round(float((gpu["muted"] - muted).abs().mean()) * 100, 2)
        with open(os.path.join(OUT, f"{tag}_{name}.json"), "w", encoding="utf-8") as f:
            json.dump(r, f, indent=1)
        print(json.dumps(r), flush=True)


if __name__ == "__main__":
    main()
