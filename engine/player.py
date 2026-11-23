"""The player's sound and picture (ROADMAP T4.1, SPEC R8, R12; old SPEC R14d). No UI code.
- Sound: what a library item plays (history.play_path: its cleaned.wav, or a saved file once the cache is gone),
  served with byte ranges. While "Clean and play" still writes it, every byte past the clean part is held back
  until it is clean, so the browser's <audio> just sees a slow network and waits (SPEC R8, option B).
- Picture: a muted <video> that follows the sound. An own video gives its picture from the file, or from a copy
  the browser can play (picture.py, first part then full); a link's picture is streamed (video only, up to 1080p,
  found with yt-dlp; nothing is downloaded) through this engine, which adds the headers the site wants.
It is found as soon as "Clean and play" starts (prepare), so it is there when the sound starts playing.
"""
import os
import subprocess
import threading
import time
import urllib.request

import downloads
import history
import library
import saves
from files import DATA_DIR, NOWIN, VIDEO_EXTS, is_link

STREAM_FRESH_S = 3600   # a found stream address is used again for this long (YouTube's last about 6 hours)
SR, FRAME_BYTES, HEADER = 44100, 4, 44   # cleaned.wav: 44.1 kHz, 16-bit stereo, 44-byte header
STREAM_FAILED = "Sound only: the picture could not be loaded."
WAVE_RATE, WAVE_BINS = 8000, 2000   # the report's sound strip: its shape is read at 8 kHz, in this many peaks
MUTED_HOP = 441          # the time bar's muted parts are read per 10 ms (the music-trace check's step)...
MUTED_MIN_FRAMES = 30    # ...and a part is at least 0.3 s of exact silence (the check mutes 0.41 s or more)


class Player:
    def __init__(self, emit, pictures):
        self.emit = emit
        self.pictures = pictures
        self.streams = {}   # row id -> {"state": running / done / error, "url", "headers", "at", "found", "text"}
        self.waves = {}     # row id -> ((path, mtime, size), shape): a strip read once per file
        self.mutes = {}     # row id -> the time bar's muted parts, read so far (muted())
        self._mute_lock = threading.Lock()
        self._lock = threading.Lock()

    # ----- The picture -----
    def _picture_source(self, r):
        """("file", path), ("stream", link) or (None, None): where row r's picture comes from."""
        if library.media_kind(r) != "video":
            return None, None
        path = history.play_path(r) or ""
        if not history.is_cache(path):
            return "file", path   # a saved or cleaned MP4: the picture is in the same file
        if is_link(r["source"]):
            return "stream", r["source"]
        if r["source"].lower().endswith(VIDEO_EXTS) and os.path.isfile(r["source"]):
            return "file", r["source"]
        return None, None

    def prepare(self, row_id):
        """Starts finding row's picture (a stream lookup, or picture.py's copy); returns what the page needs to show
        it: {"type": "none"}, {"type": "file", "item": picture item} or {"type": "stream", "state", "at", "text"}."""
        r = history.get_row(row_id)
        if not r:
            raise ValueError("Not in the library any more.")
        kind, src = self._picture_source(r)
        if kind == "stream":
            return dict(self._stream(row_id, src), type="stream")
        if kind == "file":
            folder = history.history_folder(r) or os.path.join(DATA_DIR, "pictures")
            try:
                return {"type": "file", "item": self.pictures.start({"src": src, "folder": folder})}
            except ValueError as e:   # no picture in the file after all
                return {"type": "none", "text": str(e)}
        return {"type": "none"}

    def convert(self, row_id):
        """The browser could not show the file's picture as it is: make an H.264 copy (SPEC R12)."""
        r = history.get_row(row_id)
        kind, src = self._picture_source(r) if r else (None, None)
        if kind != "file":
            raise ValueError("This item has no picture file.")
        folder = history.history_folder(r) or os.path.join(DATA_DIR, "pictures")
        return {"type": "file", "item": self.pictures.start({"src": src, "folder": folder, "how": "convert"})}

    def _stream(self, row_id, link, again=False):
        """A link's stream address, found in a thread (a few seconds); "stream" events tell the page when it is
        there. again: the site refused the old address, find a new one (once, as old Naqi did)."""
        with self._lock:
            s = self.streams.get(row_id)
            fresh = s and (s["state"] == "running" or (s["state"] == "done" and time.time() - s["found"] < STREAM_FRESH_S))
            if fresh and not again:
                return _public(row_id, s)
            s = self.streams[row_id] = {"state": "running", "url": None, "headers": {}, "at": 0, "found": 0,
                                        "text": "Finding the picture…", "again": again}
        threading.Thread(target=self._find, args=(row_id, link, s), daemon=True).start()
        return _public(row_id, s)

    def _find(self, row_id, link, s):
        try:
            url, headers, at = downloads.video_stream(link)
            if url:
                s.update(state="done", url=url, headers=dict(h.split(": ", 1) for h in headers), at=at or 0,
                         found=time.time(), text="")
            else:
                s.update(state="error", text="This link has no picture. The cleaned sound still plays.")
        except Exception:
            s.update(state="error", text=STREAM_FAILED)
        self.emit("stream", _public(row_id, s))

    def refind(self, row_id):
        """The page's <video> could not open the stream: look it up once more, then give up."""
        r = history.get_row(row_id)
        s = self.streams.get(row_id)
        if not r or not is_link(r["source"]):
            raise ValueError("This item has no stream.")
        if s and s.get("again"):
            s.update(state="error", text=STREAM_FAILED)
            self.emit("stream", _public(row_id, s))
            return dict(_public(row_id, s), type="stream")
        return dict(self._stream(row_id, r["source"], again=True), type="stream")

    def stream_request(self, row_id):
        """(address, headers) of a found stream, or None."""
        s = self.streams.get(row_id)
        return (s["url"], s["headers"]) if s and s["state"] == "done" else None

    # ----- Opening an item -----
    def open(self, row_id, job):
        """What the page needs to play a library item; job: the running "Clean and play" job, or None.
        Raises ValueError when there is nothing to play (gone), or when it must be cleaned again first."""
        r = history.get_row(row_id)
        if not r:
            raise ValueError("Not in the library any more.")
        live = bool(job and job.get("row_id") == row_id and job["state"] == "running")
        if not live and history.needs_cleaning(r):
            raise ValueError("again")
        path = history.play_path(r) or ""
        if not live and not os.path.isfile(path):
            raise ValueError("The cleaned file was moved or deleted.")
        it = library.item(r, row_id if live else None)
        return {"id": row_id, "title": it["title"], "from": it["from"], "added": it["added"], "kind": it["kind"],
                "rating": it["rating"], "live": live, "length": (job or {}).get("total_s") if live else None,
                "picture": self.prepare(row_id), "save": save_info(r, row_id if live else None)}

    # ----- The report page's sound strip (ROADMAP T5.2) -----
    def wave(self, row_id, job):
        """Row's cleaned sound for the report page: {"length": seconds, "peaks": [0..1]}, the loudest sample of
        each slice (muted parts are 0, so they show as flat gaps). It plays from /media/<id>/sound. Raises
        ValueError with words for the page when Naqi has no cleaned sound of it."""
        r = history.get_row(row_id)
        if not r:
            raise ValueError("Not in the library any more.")
        if job and job.get("row_id") == row_id and job["state"] == "running":
            raise ValueError("It is still being cleaned. Its sound shows here once it is clean.")
        if history.needs_cleaning(r):
            raise ValueError("Its cleaned sound was tidied away (Naqi keeps it 2 weeks). Type the times below, or "
                             "play it from the library first.")
        path = history.play_path(r) or ""
        if not os.path.isfile(path):
            raise ValueError("Its cleaned file was moved or deleted, so it cannot play here. Type the times below.")
        key = (path, os.path.getmtime(path), os.path.getsize(path))
        have = self.waves.get(row_id)
        if have and have[0] == key:
            return have[1]
        shape = _shape(path)
        self.waves[row_id] = (key, shape)
        return shape

    # ----- The muted parts on the player's time bar (ROADMAP T10.2b) -----
    def muted(self, row_id, job):
        """Where row's cleaned sound was muted: {"upto": seconds read, "parts": [[from, to], ...]}. Read from the
        same cleaned sound as the strip: a muted moment is exact silence there (the music-trace check sets it to 0,
        real quiet never is), so stretches of at least MUTED_MIN_S of it are the muted parts. While it is cleaned,
        only the clean part is read, and each call goes on from where the last one stopped."""
        r = history.get_row(row_id)
        if not r:
            raise ValueError("Not in the library any more.")
        path = history.play_path(r) or ""
        if not os.path.isfile(path):
            raise ValueError("The cleaned file was moved or deleted.")
        edge = clean_edge(job, row_id)
        key = (path, os.path.getmtime(path), os.path.getsize(path)) if edge is None else (path, None, None)
        with self._mute_lock:
            m = self.mutes.get(row_id)
            if not m or m["key"][0] != path or (m["key"][1] is not None and m["key"] != key):
                m = self.mutes[row_id] = {"key": key, "frames": 0, "parts": [], "open": None, "done": False}
            if not m["done"]:
                if path.lower().endswith(".wav"):
                    _scan_wav(m, path, edge)
                else:   # a saved MP3 / MP4 once the cache is gone: read it all at once with ffmpeg
                    _scan_frames(m, _decoded_frames(path))
                    m["done"] = True
                if edge is None:
                    m["key"], m["done"] = key, True
                    _close_run(m, m["frames"])
            parts = [list(p) for p in m["parts"]]
            if m["open"] is not None and m["frames"] - m["open"] >= MUTED_MIN_FRAMES:   # muted up to the clean edge
                parts.append([round(m["open"] / 100, 2), round(m["frames"] / 100, 2)])
            return {"upto": round(m["frames"] / 100, 2), "parts": parts}

    def sound_path(self, row_id):
        r = history.get_row(row_id)
        return (history.play_path(r) or None) if r else None


def save_info(r, live_id=None):
    """The player's Save panel (T4.3): can it be saved now (else why not), can it be an MP4, the files saved so far."""
    ok, why = saves.can_save(r, live_id)
    return {"can": history.is_cache(r["result"]), "ready": ok, "why": why, "video": saves.has_picture(r),
            "saved": history.saved_files(r)}


def _public(row_id, s):
    """A stream's state as the page sees it (never its address or headers)."""
    return {"row_id": row_id, "state": s["state"], "at": s["at"], "text": s["text"]}


def _shape(path):
    """A sound's length and WAVE_BINS peaks, read with ffmpeg (mono, WAVE_RATE). About a second for 10 minutes."""
    import numpy as np
    out = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", str(WAVE_RATE),
                          "-f", "s16le", "-"], capture_output=True, stdin=subprocess.DEVNULL, creationflags=NOWIN)
    x = np.abs(np.frombuffer(out.stdout, dtype="<i2").astype(np.int32))
    if out.returncode or not len(x):
        raise OSError("The cleaned sound could not be read.")
    edges = np.linspace(0, len(x), min(WAVE_BINS, len(x)) + 1).astype(int)[:-1]
    peaks = np.maximum.reduceat(x, edges) / 32768
    return {"length": round(len(x) / WAVE_RATE, 3), "peaks": [round(float(v), 3) for v in peaks]}


def _scan_wav(m, path, edge):
    """Reads cleaned.wav's frames from m["frames"] on (up to the clean edge `edge` in bytes, or the end), a minute
    at a time, so memory stays flat on a long file."""
    import numpy as np
    end = (os.path.getsize(path) if edge is None else edge) - HEADER
    total = max(0, end) // (FRAME_BYTES * MUTED_HOP)
    with open(path, "rb") as f:
        while m["frames"] < total:
            n = min(total - m["frames"], 6000)
            f.seek(HEADER + m["frames"] * MUTED_HOP * FRAME_BYTES)
            x = np.frombuffer(f.read(n * MUTED_HOP * FRAME_BYTES), dtype="<i2")
            n = len(x) // (2 * MUTED_HOP)
            if not n:
                break
            _scan_frames(m, ~x[:n * 2 * MUTED_HOP].reshape(n, -1).any(axis=1))


def _decoded_frames(path):
    """Silent or not per 10 ms of a sound file, decoded with ffmpeg (stereo s16, SR)."""
    import numpy as np
    out = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-map", "0:a:0", "-ac", "2", "-ar", str(SR),
                          "-f", "s16le", "-"], capture_output=True, stdin=subprocess.DEVNULL, creationflags=NOWIN)
    if out.returncode:
        raise OSError("The cleaned sound could not be read.")
    x = np.frombuffer(out.stdout, dtype="<i2")
    n = len(x) // (2 * MUTED_HOP)
    return ~x[:n * 2 * MUTED_HOP].reshape(n, -1).any(axis=1)


def _scan_frames(m, silent):
    """Adds the next frames (True = silent) to m: a run of silence of MUTED_MIN_FRAMES or more is a muted part."""
    import numpy as np
    base, n = m["frames"], len(silent)
    if not n:
        return
    if not silent[0]:   # a run open at the last edge ended right there
        _close_run(m, base)
    d = np.diff(np.concatenate([[0], silent.astype(np.int8), [0]]))
    for a, b in zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)):
        if not (a == 0 and m["open"] is not None):   # else the run open at the last edge goes on
            m["open"] = base + int(a)
        if b < n:
            _close_run(m, base + int(b))
    m["frames"] = base + n


def _close_run(m, end):
    if m["open"] is not None and end - m["open"] >= MUTED_MIN_FRAMES:
        m["parts"].append((round(m["open"] / 100, 2), round(end / 100, 2)))
    m["open"] = None


def clean_edge(job, row_id):
    """While row's "Clean and play" job runs: the bytes of its cleaned.wav that are final (header + clean
    samples). None when it is not being cleaned (the whole file is final)."""
    if job and job.get("row_id") == row_id and job["state"] == "running":
        return HEADER + round(job.get("ready_s", 0) * SR) * FRAME_BYTES
    return None


def open_stream(url, headers, rng):
    """Opens the site's stream for one request of the page's <video> (byte range rng, e.g. "bytes=0-")."""
    req = urllib.request.Request(url, headers=dict(headers, **({"Range": rng} if rng else {})))
    return urllib.request.urlopen(req, timeout=20)
