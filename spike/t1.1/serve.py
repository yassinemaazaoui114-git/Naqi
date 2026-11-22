"""T1.1 player spike, engine side (not product code). Cleans one file into a growing cleaned.wav with the unchanged
speech_only.clean_to_wav and serves it to the spike window on 127.0.0.1 (token in the URL, because a <video> or
<audio> element cannot send headers). Started by spike/t1.1/main.cjs; prints {"port": n} first.
Routes (all need ?t=<token>):
  POST /start               start cleaning (once)
  GET  /status              ready_s, plays, done, numbers
  GET  /wav?hold=1          the growing WAV with Range support. hold=1: bytes past the clean part are held back
                            until they are clean (the browser just sees a slow network); hold=0: the file as it is
                            on disk (silence where nothing is clean yet)
  GET  /video               the source video, with Range support
  POST /upload?name=x       what the page played (int16 stereo 44.1 kHz), compared with the finished WAV
  POST /result?name=x       the page's measurements (JSON), saved in test_out/t1.1/<name>.json
  POST /mpv?wid=n           option C: play the WAV + picture with libmpv inside the window with that handle
"""
import json
import os
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "engine"))
OUT = os.path.join(ROOT, "test_out", "t1.1")

import numpy as np   # noqa: E402

TOKEN = os.environ["SPIKE_TOKEN"]
SRC = os.environ["SPIKE_SRC"]
WAV = os.path.join(OUT, os.environ.get("SPIKE_NAME", "run") + ".wav")
SR = 44100
st = {"ready_s": 0.0, "plays": False, "done": False, "numbers": None, "error": None, "started": None,
      "first_plays_s": None, "size": 0, "log": []}
_mpv = {}


def log(text):
    st["log"].append(f"{time.time() - (st['started'] or time.time()):7.2f} {text}")


def clean():
    import speech_only

    def ready(seconds, plays):
        st["ready_s"] = seconds
        if plays and not st["plays"]:
            st["first_plays_s"] = time.time() - st["started"]
        st["plays"] = st["plays"] or plays
        log(f"ready {seconds:.1f} s plays={plays}")

    try:
        st["numbers"] = speech_only.clean_to_wav(SRC, WAV, ready=ready)
    except Exception as e:
        st["error"] = f"{type(e).__name__}: {e}"
    st["done"] = True
    log("done")


def clean_edge():
    """Bytes of the WAV that are final: the header + every clean sample."""
    return st["size"] if st["done"] else 44 + int(st["ready_s"] * SR) * 4


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _json(self, data, code=200):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _parse(self):
        url = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        if q.get("t") != TOKEN:
            self._json({"error": "forbidden"}, 403)
            return None, None
        return url.path, q

    def do_OPTIONS(self):   # fetch() with a Range header asks first
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path, q = self._parse()
        if path is None:
            return
        if path == "/status":
            self._json({k: v for k, v in st.items() if k != "log"})
        elif path == "/wav":
            self._file(WAV, hold=q.get("hold", "1") == "1")
        elif path == "/video":
            self._file(SRC, hold=False)
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        path, q = self._parse()
        if path is None:
            return
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if path == "/start":
            if not st["started"]:
                st["started"] = time.time()
                threading.Thread(target=clean, daemon=True).start()
                import speech_only
                st["size"] = 44 + round(speech_only.duration_of(SRC) * SR) * 4   # the length clean_to_wav gives it
                while not os.path.exists(WAV) or os.path.getsize(WAV) < st["size"]:
                    time.sleep(0.01)   # clean_to_wav first writes the header and the full (silent) length
            self._json({"ok": True, "size": st["size"]})
        elif path == "/upload":
            while not st["done"]:
                time.sleep(0.2)
            self._json(compare(np.frombuffer(body, "<i2").reshape(-1, 2), q.get("name", "rec")))
        elif path == "/result":
            data = json.loads(body)
            data["server_log"] = st["log"]
            data["numbers"] = st["numbers"]
            data["first_plays_s"] = st["first_plays_s"]
            with open(os.path.join(OUT, q.get("name", "run") + ".json"), "w", encoding="utf-8") as f:
                json.dump(data, f, indent=1)
            self._json({"ok": True})
        elif path == "/mpv":
            self._json(mpv_play(int(q["wid"]), q.get("cmd", "play")))
        else:
            self._json({"error": "not found"}, 404)

    def _file(self, path, hold):
        size = st["size"] if path == WAV else os.path.getsize(path)
        rng = self.headers.get("Range", "")
        a, b = 0, size - 1
        if rng.startswith("bytes="):
            lo, _, hi = rng[6:].partition("-")
            a = int(lo or 0)
            b = min(int(hi), size - 1) if hi else size - 1
        self.send_response(206 if rng else 200)
        self.send_header("Content-Type", "audio/wav" if path == WAV else "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(b - a + 1))
        if rng:
            self.send_header("Content-Range", f"bytes {a}-{b}/{size}")
        self.end_headers()
        if path == WAV:
            log(f"wav request {a}-{b} hold={hold} (clean edge {clean_edge()})")
        try:
            with open(path, "rb") as f:
                pos = a
                while pos <= b:
                    end = min(b + 1, pos + 65536)
                    if hold and not st["done"]:
                        while clean_edge() <= pos and not st["done"]:
                            time.sleep(0.05)   # not clean yet: hold the browser here
                        if not st["done"]:
                            end = min(end, clean_edge())
                    f.seek(pos)
                    data = f.read(end - pos)
                    data += b"\0" * (end - pos - len(data))   # the final file can be a little shorter
                    self.wfile.write(data)
                    pos = end
        except (ConnectionError, OSError):   # the browser dropped this request (it does so on seeks)
            pass


def compare(rec, name):
    """Find where each second of what was played comes from in the finished WAV. A player that plays the file
    exactly gives long runs that match sample for sample; a gap, a repeat or a click breaks a run."""
    with open(WAV, "rb") as f:
        f.seek(44)
        ref = np.frombuffer(f.read(), "<i2").reshape(-1, 2).astype(np.int32)
    rec = rec.astype(np.int32)
    win = SR // 2
    runs, off, silent, bad = [], None, 0, []
    for w0 in range(0, len(rec) - win, win):
        seg = rec[w0:w0 + win]
        if np.abs(seg).max() < 2:   # silence (before start, a pause, a wait)
            silent += 1
            continue
        hit = None
        if off is not None and 0 <= w0 - off and w0 - off + win <= len(ref):
            if np.abs(seg - ref[w0 - off:w0 - off + win]).max() <= 1:
                hit = off
        if hit is None:
            k = _find(seg, ref)
            hit = None if k is None else w0 - k
        if hit is None:
            bad.append(round(w0 / SR, 2))
            off = None
            continue
        if runs and runs[-1]["off"] == hit and runs[-1]["end"] == w0:
            runs[-1]["end"] = w0 + win
        else:
            runs.append({"off": hit, "start": w0, "end": w0 + win})
        off = hit
    out = {"name": name, "played_s": round(len(rec) / SR, 2), "silent_halfseconds": silent,
           "unmatched_at_s": bad[:50], "unmatched": len(bad),
           "runs": [{"played_from_s": round(r["start"] / SR, 3), "file_from_s": round((r["start"] - r["off"]) / SR, 3),
                     "length_s": round((r["end"] - r["start"]) / SR, 1)} for r in runs]}
    with open(os.path.join(OUT, name + "_compare.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    return out


def _find(seg, ref):
    """Start k in the file with seg == ref[k:k + len(seg)] (within 1 step), by cross-correlation of the left channel."""
    x = seg[:, 0].astype(np.float64)
    if not x.any():
        return None
    r = ref[:, 0].astype(np.float64)
    n = 1 << int(np.ceil(np.log2(len(r) + len(x))))
    c = np.fft.irfft(np.fft.rfft(r, n) * np.conj(np.fft.rfft(x, n)), n)[:len(r) - len(x) + 1]
    for k in np.argsort(c)[-5:][::-1]:
        if np.abs(seg - ref[k:k + len(seg)]).max() <= 1:
            return int(k)
    return None


def mpv_play(wid, cmd):
    """Option C: libmpv drawn into the Electron window (as old Naqi does inside its Qt window)."""
    if cmd == "play":
        os.environ["PATH"] = os.path.join(os.environ["USERPROFILE"], "Naqi-data", "bin") + os.pathsep + os.environ["PATH"]
        import mpv
        t0 = time.time()
        p = mpv.MPV(wid=str(wid), keep_open="yes", osc=False, input_default_bindings=False)
        p.play(WAV)
        p.wait_until_playing()
        t1 = time.time()
        p.command("video-add", SRC, "select")
        _mpv["p"] = p
        return {"ok": True, "load_s": round(t1 - t0, 2)}
    p = _mpv.get("p")
    if not p:
        return {"ok": False}
    if cmd == "pos":
        return {"audio": p.time_pos, "frame": p.estimated_frame_number, "fps": p.container_fps,
                "vid": p.vid, "avsync": p.avsync}
    if cmd == "stop":
        p.terminate()
        _mpv.clear()
    return {"ok": True}


def main():
    os.makedirs(OUT, exist_ok=True)
    if os.path.exists(WAV):
        os.remove(WAV)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    import speech_only
    speech_only.warm_up()   # models loaded before the window asks, like the real engine
    print(json.dumps({"port": server.server_address[1]}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
