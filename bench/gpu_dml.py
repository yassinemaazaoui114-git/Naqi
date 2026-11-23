"""CPU-only speed (ROADMAP T8.2): the heavy middle of each model on the PC's other graphics (Intel / AMD) through
DirectML, against PyTorch on the CPU, on one 8 s piece. Needs the .onnx files from bench/cpu_onnx.py and
onnxruntime-directml in the folder given as NAQI_DML (kept apart from the normal onnxruntime).
Usage: NAQI_DML=<folder> py -3.12 bench/gpu_dml.py   (results: test_out/t8.2/dml.json)
"""
import json
import os
import sys

sys.path.insert(0, os.environ["NAQI_DML"])
import onnxruntime as ort  # noqa: E402  (the DirectML build)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cpu_onnx as co  # noqa: E402

import torch  # noqa: E402

so = co.so


def main():
    voice, effects = so._models()
    mix = next(so._blocks(os.path.join(co.HERE, "samples", "narration_30s.mp3"), 10, lambda: False))[0]
    audio = torch.from_numpy(mix.T[:, :so.PIECE_S * so.SR].copy())[None]
    r = {"providers": ort.get_available_providers()}
    with torch.no_grad():
        x = co.core_input(voice, audio)
        r["voice_core_cpu_s"], m_ref = co.best(lambda: co.RoformerCore(voice).eval()(x), 1)
        rest = so.resample(audio[0], so.SR, so.BANDIT_SR)[None]
        z = effects.band_split(effects.stft(rest.mean(1, keepdim=True)))
        r["effects_tf_cpu_s"], q_ref = co.best(lambda: effects.tf_model(z), 1)
    for dev in (0, 1):
        for name, path, feed, ref in (("voice_core", "roformer_core.onnx", {"x": x.numpy()}, m_ref),
                                      ("effects_tf", "bandit_tf.onnx", {"z": z.numpy()}, q_ref)):
            key = f"{name}_dml{dev}"
            try:
                opts = ort.SessionOptions()
                opts.enable_mem_pattern = False   # DirectML needs these two off
                opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
                sess = ort.InferenceSession(os.path.join(co.OUT, "onnx", path), opts,
                                            providers=[("DmlExecutionProvider", {"device_id": dev})])
                sess.run(None, feed)   # first run builds the graph
                r[key + "_s"], y = co.best(lambda: sess.run(None, feed)[0])
                r[key + "_snr_db"] = round(co.snr(ref, torch.from_numpy(y)), 1)
            except Exception as e:  # noqa: BLE001  (a device may not exist or fail; report it)
                r[key + "_error"] = str(e)[:200]
            print(key, {k: v for k, v in r.items() if k.startswith(key)}, flush=True)
    r = {k: round(v, 3) if isinstance(v, float) else v for k, v in r.items()}
    with open(os.path.join(co.OUT, "dml.json"), "w", encoding="utf-8") as f:
        json.dump(r, f, indent=1)
    print(json.dumps(r, indent=1))


if __name__ == "__main__":
    main()
