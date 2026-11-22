"""Test + measurement for speech_only.py.
Usage: python test_speech_only.py [file ...]   (default: every mp3/mp4 in samples/)
Works on copies in test_out/, so the samples stay untouched. Prints time, speed, VRAM, muted share.
"""
import glob
import os
import shutil
import sys

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")   # the project folder (samples/, test_out/)
sys.path.insert(0, os.path.join(HERE, "engine"))

import speech_only  # noqa: E402

OUT = os.path.join(HERE, "test_out")


def main():
    files = sys.argv[1:] or sorted(glob.glob(os.path.join(HERE, "samples", "*.mp[34]")))
    if not files:
        sys.exit("No sample files. Put an mp3/mp4 in samples/ or pass a path.")
    os.makedirs(OUT, exist_ok=True)
    failed = False
    for src in files:
        dst = os.path.join(OUT, os.path.basename(src))
        shutil.copyfile(src, dst)
        before = speech_only.duration_of(dst)
        r = speech_only.clean_file(dst)
        after = speech_only.duration_of(dst)
        ok = after > 0 and abs(after - before) < 0.2
        failed |= not ok
        print(f"{'PASS' if ok else 'FAIL'}  {os.path.basename(src)}")
        print(f"      length {before:.1f}s -> {after:.1f}s | took {r['seconds']:.1f}s = {r['speed_x']:.0f}x realtime"
              f" (separation {r['separation_s']:.1f}s) | {r['device']} | peak VRAM {r['peak_vram_mb']:.0f} MB"
              f" | muted by the trace check {r['muted_fraction'] * 100:.0f}%")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
