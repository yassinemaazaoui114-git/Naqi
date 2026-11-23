"""CPU-only speed (ROADMAP T8.2): can ONNX Runtime run the heavy middle of each model faster than PyTorch on the CPU?
Exports Roformer's band split + transformer layers + mask head, and Bandit's time-frequency model, then times one
8 s piece in PyTorch and in ONNX Runtime and checks the outputs match.
Usage: py -3.12 bench/cpu_onnx.py   (results: test_out/t8.2/onnx.json, the .onnx files in test_out/t8.2/onnx/)
"""
import json
import os
import sys
import time

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(HERE, "engine"))

import torch  # noqa: E402
from einops import pack, rearrange, unpack  # noqa: E402

import speech_only as so  # noqa: E402

OUT = os.path.join(HERE, "test_out", "t8.2")


class RoformerCore(torch.nn.Module):
    """MelBandRoformer.forward between the STFT and the mask: x (b, t, f*c) -> masks (b, t, f*c)."""

    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, x):
        net = self.net
        x = net.band_split(x)
        for time_t, freq_t in net.layers:
            x = rearrange(x, "b t f d -> b f t d")
            x, ps = pack([x], "* t d")
            x = time_t(x)
            x, = unpack(x, ps, "* t d")
            x = rearrange(x, "b f t d -> b t f d")
            x, ps = pack([x], "* f d")
            x = freq_t(x)
            x, = unpack(x, ps, "* f d")
        return net.mask_estimators[0](x)


def core_input(net, audio):
    """The tensor RoformerCore takes, from audio (b, 2, n): the same steps as the model's own forward."""
    b = audio.shape[0]
    flat = audio.reshape(-1, audio.shape[-1])
    s = torch.view_as_real(torch.stft(flat, **net.stft_kwargs, window=net.stft_window_fn(device="cpu"),
                                      return_complex=True))
    s = s.reshape(b, 2, *s.shape[1:])
    s = rearrange(s, "b s f t c -> b (f s) t c")
    x = s[torch.arange(b)[..., None], net.freq_indices]
    return rearrange(x, "b f t c -> b t (f c)")


def best(fn, n=3):
    times = []
    for _ in range(n):
        t = time.perf_counter()
        y = fn()
        times.append(time.perf_counter() - t)
    return min(times), y


def snr(ref, y):
    return float(10 * torch.log10(ref.pow(2).sum() / ((ref - y).pow(2).sum() + 1e-12)))


def main():
    import onnxruntime as ort
    os.makedirs(os.path.join(OUT, "onnx"), exist_ok=True)
    voice, effects = so._models()
    torch.manual_seed(0)
    r = {"threads": torch.get_num_threads()}

    # one 8 s piece of a real mix
    mix = next(so._blocks(os.path.join(HERE, "samples", "narration_30s.mp3"), 10, lambda: False))[0]
    audio = torch.from_numpy(mix.T[:, :so.PIECE_S * so.SR].copy())[None]

    with torch.no_grad():
        r["voice_full_torch_s"], _ = best(lambda: voice(audio))
        core = RoformerCore(voice).eval()
        x = core_input(voice, audio)
        r["voice_core_torch_s"], m_torch = best(lambda: core(x))
        path = os.path.join(OUT, "onnx", "roformer_core.onnx")
        if not os.path.exists(path):
            torch.onnx.export(core, (x,), path, input_names=["x"], output_names=["m"], opset_version=18,
                              dynamo=False, dynamic_axes={"x": {0: "b"}, "m": {0: "b"}})
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        sess = ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])
        r["voice_core_ort_s"], m_ort = best(lambda: sess.run(None, {"x": x.numpy()})[0])
        r["voice_core_snr_db"] = round(snr(m_torch, torch.from_numpy(m_ort)), 1)

        # Bandit's time-frequency model (the GRUs), on the mono STFT as the engine uses it
        rest = so.resample(audio[0], so.SR, so.BANDIT_SR)[None]
        mono = effects.stft(rest.mean(1, keepdim=True))
        z = effects.band_split(mono)
        r["effects_bandsplit_torch_s"], _ = best(lambda: effects.band_split(mono))
        r["effects_tf_torch_s"], q_torch = best(lambda: effects.tf_model(z))
        r["effects_mask_torch_s"], _ = best(lambda: effects.mask_estim["sfx"](q_torch))
        path = os.path.join(OUT, "onnx", "bandit_tf.onnx")
        if not os.path.exists(path):
            torch.onnx.export(effects.tf_model, (z,), path, input_names=["z"], output_names=["q"], opset_version=18,
                              dynamo=False, dynamic_axes={"z": {0: "b"}, "q": {0: "b"}})
        sess = ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])
        r["effects_tf_ort_s"], q_ort = best(lambda: sess.run(None, {"z": z.numpy()})[0])
        r["effects_tf_snr_db"] = round(snr(q_torch, torch.from_numpy(q_ort)), 1)

    r = {k: round(v, 3) if isinstance(v, float) else v for k, v in r.items()}
    with open(os.path.join(OUT, "onnx.json"), "w", encoding="utf-8") as f:
        json.dump(r, f, indent=1)
    print(json.dumps(r, indent=1))


if __name__ == "__main__":
    main()
