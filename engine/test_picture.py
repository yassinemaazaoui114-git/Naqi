"""Test of the player's picture (ROADMAP T1.2) through the real engine server. Starts server.py like Electron does and:
- gets the picture of every clip in samples/codecs (made by spike/t1.2/make_samples.sh): played as is, remuxed or
  converted as expected, and copies as long as the original;
- the 9 min 1080p Xvid next to a real "sound" cleaning job of it: the first-part copy is ready before the sound
  plays, the full copy before the viewer reaches the end of the first part; prints the times;
- a finished copy is reused, cancel, a new start stops the old one, an audio file is refused in plain words,
  how="convert" forces a copy.
Every file the player would show is put in test_out/t1.2/play/; then run the browser check on them:
  node_modules/.bin/electron spike/t1.2/probe.cjs test_out/t1.2/play
Run: py -3.12 engine/test_picture.py   (exit code 0 when all checks pass; about 3 min, GPU for the cleaning)
"""
import glob
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CODECS = os.path.join(ROOT, "samples", "codecs")
LONG = os.path.join(ROOT, "samples", "codecs_long", "xvid_9min.avi")
AUDIO = os.path.join(ROOT, "samples", "narration_30s.mp3")
PLAY = os.path.join(ROOT, "test_out", "t1.2", "play")
TOKEN = secrets.token_hex(32)
TMP = tempfile.mkdtemp(prefix="naqie-picture-")
# Measured in Electron 45 (spike/t1.2/probe.cjs on the originals): what each clip needs
CONVERT = {"divx3.avi", "mjpeg.avi", "mpeg2.mkv", "mpeg4.mp4", "prores.mov", "wmv2.wmv", "xvid.avi"}
REMUX = {"h264.avi"}
failed = 0
events = {"picture": [], "job": []}
state = {}


def check(name, ok, detail=""):
    global failed
    failed += not ok
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""), flush=True)


def call(path, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method="POST" if body is not None else "GET",
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.load(res)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)


def listen():
    req = urllib.request.Request(f"http://127.0.0.1:{port}/events", headers={"Authorization": "Bearer " + TOKEN})
    event = None
    try:
        with urllib.request.urlopen(req) as res:
            for line in res:
                line = line.decode().rstrip("\n")
                if line.startswith("event: "):
                    event = line[7:]
                elif line.startswith("data: "):
                    data = json.loads(line[6:])
                    if event in events:
                        events[event].append(dict(data, at=time.time()))
                    elif event == "state":
                        state.update(data)
    except OSError:   # the server was stopped at the end of the test
        pass


def wait_end(kind, item_id, limit_s):
    end = time.time() + limit_s
    while time.time() < end:
        last = [e for e in events[kind] if e["id"] == item_id]
        if last and last[-1]["state"] != "running":
            return last[-1]
        time.sleep(0.05)
    return {"state": "timeout"}


def first(kind, item_id, test, limit_s):
    """Time of the first event of this item that passes test, or None."""
    end = time.time() + limit_s
    while time.time() < end:
        for e in events[kind]:
            if e["id"] == item_id and test(e):
                return e["at"]
        time.sleep(0.05)
    return None


def length_s(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                         capture_output=True, text=True).stdout.strip()
    return float(out or 0)


def keep(path, name):
    """Put a file the player would show into test_out/t1.2/play for the browser check."""
    shutil.copyfile(path, os.path.join(PLAY, name + os.path.splitext(path)[1]))


samples = sorted(glob.glob(os.path.join(CODECS, "*")))
if not samples or not os.path.isfile(LONG) or not os.path.isfile(AUDIO):
    sys.exit("Missing samples: run bash spike/t1.2/make_samples.sh; samples/narration_30s.mp3 is also needed")
shutil.rmtree(PLAY, ignore_errors=True)
os.makedirs(PLAY)

env = dict(os.environ, NAQI_TOKEN=TOKEN, NAQI_PARENT_PID=str(os.getpid()), NAQIE_DATA=TMP, PYTHONIOENCODING="utf-8")
server = subprocess.Popen([sys.executable, "-u", os.path.join(HERE, "server.py")], cwd=HERE, env=env,
                          stdout=subprocess.PIPE, text=True)
try:
    port = json.loads(server.stdout.readline())["port"]
    threading.Thread(target=listen, daemon=True).start()

    # 1. Every codec clip
    for src in samples:
        name = os.path.basename(src)
        want = "convert" if name in CONVERT else "remux" if name in REMUX else "as-is"
        t = time.time()
        code, item = call("/pictures", {"src": src, "folder": os.path.join(TMP, name)})
        end = wait_end("picture", item.get("id"), 60) if code == 200 else {"state": code}
        full = end.get("full") or ""
        same = abs(length_s(full) - length_s(src)) < 0.2 if full else False
        check(f"{name}: {want}", end["state"] == "done" and item.get("how") == want and os.path.isfile(full) and same,
              f"{item.get('how')}, {end['state']} in {time.time() - t:.1f} s, "
              f"{length_s(full):.2f} s long" + (f", {end.get('detail')}" if end.get("detail") else ""))
        if full:
            keep(full, os.path.splitext(name)[0] + "_" + item["how"])

    # 2. Refusals and plain words
    code, res = call("/pictures", {"src": AUDIO, "folder": os.path.join(TMP, "audio")})
    check("audio file refused in plain words", code == 400 and "can't be shown" in res.get("error", ""), res.get("error"))
    code, res = call("/pictures", {"src": AUDIO})
    check("missing folder refused", code == 400, res.get("error"))

    # 3. Forced copy (the player asks for it when the browser fails on a file it was expected to play)
    code, item = call("/pictures", {"src": os.path.join(CODECS, "hevc.mp4"), "folder": os.path.join(TMP, "forced"),
                                    "how": "convert"})
    end = wait_end("picture", item.get("id"), 60)
    check("how=convert forces an H.264 copy", end["state"] == "done" and item["how"] == "convert"
          and end["full"].endswith("picture.mp4"), f"{end['state']}")
    if end.get("full"):
        keep(end["full"], "hevc_forced_convert")

    # 4. Cancel, and a new start stops the old one
    folder = os.path.join(TMP, "cancel")
    code, item = call("/pictures", {"src": LONG, "folder": folder})
    time.sleep(1.5)
    t = time.time()
    call(f"/pictures/{item['id']}/cancel", {})
    end = wait_end("picture", item["id"], 10)
    left = [f for f in os.listdir(folder)] if os.path.isdir(folder) else []
    check("cancel stops the copy and leaves no file", end["state"] == "cancelled" and not left,
          f"{end['state']} in {time.time() - t:.2f} s, left {left}")
    code, old = call("/pictures", {"src": LONG, "folder": os.path.join(TMP, "replaced")})
    time.sleep(1)
    code, new = call("/pictures", {"src": os.path.join(CODECS, "h264.avi"), "folder": os.path.join(TMP, "new")})
    check("a new start stops the old one", wait_end("picture", old["id"], 10)["state"] == "cancelled"
          and wait_end("picture", new["id"], 30)["state"] == "done")

    # 5. The 9 min 1080p Xvid next to a real cleaning job of it (what "Clean and play" does)
    t0 = time.time()
    while not state.get("models") and state.get("state") != "error" and time.time() - t0 < 180:
        time.sleep(0.1)
    check("engine ready with the models loaded", state.get("models") is True, state.get("error") or "")
    folder = os.path.join(TMP, "long")
    t0 = time.time()
    code, job = call("/jobs", {"kind": "sound", "src": LONG, "wav": os.path.join(folder, "cleaned.wav")})
    code, item = call("/pictures", {"src": LONG, "folder": folder})
    part_at = first("picture", item["id"], lambda e: e.get("part"), 120)
    if part_at:
        keep([e for e in events["picture"] if e["id"] == item["id"] and e.get("part")][0]["part"], "xvid_9min_part")
    plays_at = first("job", job["id"], lambda e: e.get("plays"), 120)
    end = wait_end("picture", item["id"], 300)
    job_end = wait_end("job", job["id"], 300)
    part_s = end.get("part_s", 0)
    if part_at and plays_at:
        late = end["at"] - plays_at   # the viewer is this far into the video when the full copy is ready
        check("first part ready before the sound plays", part_at <= plays_at + 0.5,
              f"part ({part_s:.0f} s of video) after {part_at - t0:.1f} s, sound plays after {plays_at - t0:.1f} s")
        check("full copy ready before the viewer reaches the end of the part", late < part_s,
              f"full after {end['at'] - t0:.1f} s, viewer at {late:.0f} s of {part_s:.0f} s")
    else:
        check("first part and sound arrived", False, f"part {part_at}, plays {plays_at}, {end.get('detail')}")
    n = job_end.get("numbers") or {}
    print(f"     cleaning next to it: {n.get('seconds', 0):.1f} s for {n.get('duration_s', 0):.0f} s of sound "
          f"({n.get('speed_x', 0):.1f}x), peak VRAM {n.get('peak_vram_mb', 0) / 1024:.2f} GB", flush=True)
    full = end.get("full") or ""
    check("9 min copy is as long as the original", full and abs(length_s(full) - length_s(LONG)) < 0.2,
          f"{length_s(full):.2f} s vs {length_s(LONG):.2f} s")
    check("first-part copy dropped once the full copy is there",
          not os.path.exists(os.path.join(folder, "picture_part.mp4")))
    if full:
        keep(full, "xvid_9min_convert")
    t = time.time()
    code, again = call("/pictures", {"src": LONG, "folder": folder})
    end = wait_end("picture", again["id"], 30)
    check("a finished copy is reused", end["state"] == "done" and time.time() - t < 2, f"{time.time() - t:.2f} s")
finally:
    call("/shutdown", {})
    server.wait(10)
    shutil.rmtree(TMP, ignore_errors=True)

print(f"\n{'ALL PASS' if not failed else f'{failed} FAILED'}; files for the browser check in {PLAY}")
sys.exit(1 if failed else 0)
