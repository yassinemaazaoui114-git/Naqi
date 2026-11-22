"""Test of the cleaning jobs through the real engine server (ROADMAP T0.5). Starts server.py like Electron does
(token, local port), listens to its event stream and runs: a 30 s "sound" job (chunked cleaned.wav), a 30 s
"file" job (MP3), the refusals (busy, bad request, no token), a cancel, and a 5 min file job. Its speed is compared
with the same speech_only.clean_file called directly right after (old Naqi's code, unchanged), because this PC's
speed changes from day to day (old SPEC: 43 to 55 s for the same clip); old Naqi's best was 7x realtime, 3.6 GB.
Prints time and VRAM of each job.
Needs samples/narration_over_music.mp3 (5 min, from old Naqi's samples) and samples/narration_30s.mp3 (30 s of it).
Run: py -3.12 engine/test_jobs.py   (exit code 0 when all checks pass)
"""
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
SAMPLES = os.path.join(os.path.dirname(HERE), "samples")
SHORT = os.path.join(SAMPLES, "narration_30s.mp3")
LONG = os.path.join(SAMPLES, "narration_over_music.mp3")
TOKEN = secrets.token_hex(32)
TMP = tempfile.mkdtemp(prefix="naqie-jobs-")
failed = 0
events = []          # every "job" event, in order
state = {}


def check(name, ok, detail=""):
    global failed
    failed += not ok
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""), flush=True)


def call(path, body=None, token=TOKEN):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method="POST" if body is not None else "GET",
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.load(res)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)


def listen():
    try:
        _listen()
    except OSError:   # the server was stopped at the end of the test
        pass


def _listen():
    req = urllib.request.Request(f"http://127.0.0.1:{port}/events", headers={"Authorization": "Bearer " + TOKEN})
    event = None
    with urllib.request.urlopen(req) as res:
        for line in res:
            line = line.decode().rstrip("\n")
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
                if event == "job":
                    events.append(data)
                elif event == "state":
                    state.update(data)


def wait_end(job_id, limit_s):
    end = time.time() + limit_s
    while time.time() < end:
        last = [e for e in events if e["id"] == job_id]
        if last and last[-1]["state"] != "running":
            return last[-1]
        time.sleep(0.1)
    return {"state": "timeout"}


def numbers(job):
    n = job.get("numbers") or {}
    return (f"{n.get('duration_s', 0):.1f} s of sound in {n.get('seconds', 0):.1f} s = {n.get('speed_x', 0):.1f}x "
            f"realtime, {n.get('device')}, peak VRAM {n.get('peak_vram_mb', 0) / 1024:.2f} GB")


def length_s(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                         capture_output=True, text=True).stdout.strip()
    return float(out or 0)


for f in (SHORT, LONG):
    if not os.path.isfile(f):
        sys.exit(f"Missing sample: {f}")

env = dict(os.environ, NAQI_TOKEN=TOKEN, NAQI_PARENT_PID=str(os.getpid()), NAQIE_DATA=TMP, PYTHONIOENCODING="utf-8")
server = subprocess.Popen([sys.executable, "-u", os.path.join(HERE, "server.py")], cwd=HERE, env=env,
                          stdout=subprocess.PIPE, text=True)
try:
    port = json.loads(server.stdout.readline())["port"]
    threading.Thread(target=listen, daemon=True).start()
    t0 = time.time()
    while not state.get("models") and state.get("state") != "error" and time.time() - t0 < 120:
        time.sleep(0.1)
    check("engine ready with the models loaded", state.get("models") is True,
          f"{time.time() - t0:.1f} s, {state.get('error') or 'no error'}")

    # 1. "clean a sound": 30 s, chunked into cleaned.wav
    wav = os.path.join(TMP, "item", "cleaned.wav")
    code, job = call("/jobs", {"kind": "sound", "src": SHORT, "wav": wav})
    check("sound job starts", code == 200 and job.get("state") == "running", f"{code} {job}")
    code2, busy = call("/jobs", {"kind": "sound", "src": SHORT, "wav": wav + "2"})
    check("a second job while one runs is refused", code2 == 409, f"{code2} {busy.get('error')}")
    end = wait_end(job["id"], 120)
    mine = [e for e in events if e["id"] == job["id"]]
    check("sound job finishes", end["state"] == "done", end.get("text"))
    check("sound job reports progress", sum(e["state"] == "running" for e in mine) >= 3, f"{len(mine)} events")
    check("sound job says when it can play", any(e.get("plays") for e in mine) and end.get("ready_s", 0) > 29,
          f"ready {end.get('ready_s', 0):.1f} s")
    check("cleaned.wav has the full length", abs(length_s(wav) - 30.0) < 0.2, f"{length_s(wav):.2f} s")
    print("     sound job:", numbers(end), flush=True)
    code, got = call(f"/jobs/{job['id']}")
    check("the job can be read back", code == 200 and got.get("state") == "done")

    # 2. "clean a file": 30 s into an MP3
    mp3 = os.path.join(TMP, "out", "narration_30s.mp3")
    code, job = call("/jobs", {"kind": "file", "src": SHORT, "dst": mp3, "kbps": 192})
    end = wait_end(job["id"], 120)
    check("file job finishes", end["state"] == "done", end.get("text"))
    check("the MP3 is made with the full length", os.path.isfile(mp3) and abs(length_s(mp3) - 30.0) < 0.3,
          f"{length_s(mp3) if os.path.isfile(mp3) else 0:.2f} s")
    check("the original is not changed", abs(length_s(SHORT) - 30.0) < 0.1)
    print("     file job: ", numbers(end), flush=True)

    # 3. refusals
    code, e = call("/jobs", {"kind": "other"})
    check("a bad job is refused", code == 400, e.get("error"))
    code, e = call("/jobs", {"kind": "file", "src": os.path.join(TMP, "none.mp3"), "dst": mp3})
    check("a missing file is refused with a message", code == 400 and "not found" in e.get("error", ""), e.get("error"))
    code, e = call("/jobs", {"kind": "file", "src": SHORT, "dst": mp3}, token="wrong")
    check("a request without the token is refused", code == 403)

    # 4. cancel a 5 min job early: it ends as cancelled and leaves no file
    half = os.path.join(TMP, "out", "cancelled.mp3")
    code, job = call("/jobs", {"kind": "file", "src": LONG, "dst": half})
    while not any(e["id"] == job["id"] and e["frac"] > 0.05 for e in events):
        time.sleep(0.1)
    t_cancel = time.time()
    code, ok = call(f"/jobs/{job['id']}/cancel", {})
    end = wait_end(job["id"], 60)
    check("cancel stops the job", ok.get("ok") and end["state"] == "cancelled", f"{time.time() - t_cancel:.2f} s")
    check("a cancelled job leaves no file", not os.path.exists(half))
    code, ok = call(f"/jobs/{job['id']}/cancel", {})
    check("cancel of a finished job does nothing", ok.get("ok") is False)

    # 5. speed check on 5 min (old Naqi: about 7x realtime, 5 min in ~43 s, peak VRAM 3.6 GB)
    full = os.path.join(TMP, "out", "narration_5min.mp3")
    code, job = call("/jobs", {"kind": "file", "src": LONG, "dst": full})
    end = wait_end(job["id"], 600)
    n = end.get("numbers") or {}
    check("5 min file job finishes", end["state"] == "done", end.get("text"))
    print("     5 min job:", numbers(end), flush=True)
    check("peak VRAM fits (<= 3.7 GB)", n.get("device") == "cuda" and n.get("peak_vram_mb", 1e9) <= 3.7 * 1024,
          f"{n.get('peak_vram_mb', 0) / 1024:.2f} GB")
finally:
    server.kill()
    server.wait()

# The same 5 min clean, called directly as old Naqi does (no server, no job), on the same GPU right after
sys.path.insert(0, HERE)
import speech_only   # noqa: E402
speech_only.warm_up()
direct = speech_only.clean_file(os.path.join(TMP, "direct.mp3"), 192, src=LONG)
shutil.rmtree(TMP, ignore_errors=True)
print(f"     direct:    {direct['duration_s']:.1f} s of sound in {direct['seconds']:.1f} s = {direct['speed_x']:.1f}x "
      f"realtime, {direct['device']}, peak VRAM {direct['peak_vram_mb'] / 1024:.2f} GB", flush=True)
check("the job is as fast as the old code called directly (within 10%)",
      n.get("speed_x", 0) >= 0.9 * direct["speed_x"], f"{n.get('speed_x', 0):.2f}x vs {direct['speed_x']:.2f}x")

print(f"\n{'ALL PASS' if not failed else f'{failed} FAILED'}")
sys.exit(1 if failed else 0)
