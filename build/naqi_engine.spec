# PyInstaller recipe (T7.1): packs engine/server.py and everything it needs into one folder with NaqiEngine.exe.
# Run through build/make-installer.mjs. ffmpeg, ffprobe and deno are copied from this PC into bin/, and the two model
# files from Naqi-data\models into models/, so the installed app needs nothing else (old Naqi SPEC R9, 4b).
import os
import shutil

import yt_dlp
from PyInstaller.utils.hooks import collect_all

engine = os.path.join(SPECPATH, "..", "engine")

tools = [(shutil.which(name), "bin") for name in ("ffmpeg", "ffprobe", "deno")]
missing = [name for name, (path, _) in zip(("ffmpeg", "ffprobe", "deno"), tools) if not path]
if missing:
    raise SystemExit(f"Not found on this PC: {missing}")

models = os.path.join(os.environ.get("NAQI_DATA") or os.path.join(os.path.expanduser("~"), "Naqi-data"), "models")
big = []
for name in ("MelBandRoformer.ckpt", "bandit_v2_multi.ckpt"):
    if not os.path.exists(os.path.join(models, name)):
        raise SystemExit(f"Model file {name} not found in {models}")
    big.append((os.path.join(models, name), "models"))

datas = big + [(os.path.join(engine, "separators", "mel_bands.npy"), "separators"),
               # ytdlp_update reads the bundled yt-dlp's version from this file (frozen modules have no .py files)
               (os.path.join(os.path.dirname(yt_dlp.__file__), "version.py"), "yt_dlp")]
ejs_datas, ejs_binaries, ejs_hidden = collect_all("yt_dlp_ejs")
# curl_cffi: lets yt-dlp download from TikTok (yt-dlp only loads it when present, so name it here)
cffi_datas, cffi_binaries, cffi_hidden = collect_all("curl_cffi")

a = Analysis(
    [os.path.join(engine, "server.py")],
    pathex=[engine],
    binaries=tools + ejs_binaries + cffi_binaries,
    datas=datas + ejs_datas + cffi_datas,
    hiddenimports=ejs_hidden + cffi_hidden,
    # demucs and silero_vad are only for old Naqi's benchmarks (the end of speech_only.py), never used here. The
    # rest are installed on this PC for other things and only reached through optional imports (about 1 GB)
    excludes=["tkinter", "matplotlib", "IPython", "pytest", "torchvision", "tensorboard", "pandas",
              "demucs", "silero_vad", "onnxruntime", "onnx", "cupy", "polars", "cv2", "llvmlite", "numba",
              "pyarrow", "av"],
)
pyz = PYZ(a.pure)
# console=True: Electron reads the engine's first output line (its port); it starts it with no window (windowsHide)
exe = EXE(pyz, a.scripts, exclude_binaries=True, name="NaqiEngine", icon=os.path.join(SPECPATH, "icon.ico"),
          console=True, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, upx=False, name="NaqiEngine")
