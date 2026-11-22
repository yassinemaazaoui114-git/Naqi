"""Picture for the player (ROADMAP T1.2, SPEC R12): the player shows an own video's picture in a muted <video>, and
the browser plays fewer video formats than mpv did in old Naqi. Measured in Electron 45 (test_out/t1.2/): H.264,
HEVC, AV1, VP9 and VP8 play from MP4 / MOV / M4V / MKV / WebM; AVI and WMV never open, and MPEG-4 Part 2
(Xvid, DivX), MPEG-2, MJPEG, WMV and ProRes never show a picture.
So each video gets one of three ways ("how"):
- "as-is": the browser plays the file itself.
- "remux": the picture is copied untouched into an MKV (a codec the browser plays, in AVI): well under a second.
- "convert": the picture is re-encoded to H.264 (x264 ultrafast, at most 1080p, about 20x realtime at 1080p; NVENC
  was slower here because decoding is the slow part). A long video first gets a copy of its first part, so playing
  starts as soon as the sound does, then the full copy; the player switches to it once (SPEC R12).
Copies hold only the picture (the sound comes from cleaned.wav) and go into the caller's folder (the history row's
folder), so they follow the same clean-up rule (2 weeks / 5 GB). A finished copy is reused next time.
"""
import os
import subprocess
import threading
import time

from files import NOWIN

PLAYS_CODECS = ("h264", "hevc", "av1", "vp9", "vp8")
PLAYS_PIXELS = ("yuv420p", "yuvj420p", "yuv420p10le")   # 4:2:2 / 4:4:4 pictures are not decoded by the browser
PLAYS_CONTAINERS = ("mov,mp4", "matroska")              # ffprobe format names (MP4/MOV/M4V, MKV/WebM)
COPY_HEIGHT = 1080      # converted copies are at most this tall (only for watching; saving uses the original)
PART_MIN_S, PART_MAX_S, PART_SHARE = 240, 600, 0.08   # first part: 8% of the video, between 4 and 10 min
FULL_ONLY_S = 360       # up to 6 min the full copy is ready as soon as the sound (~18 s), so no first part
PROGRESS_EVERY_S = 0.25
NO_PICTURE = "This video's picture can't be shown. The cleaned sound still plays."


def plan(path):
    """How the player gets this video's picture: {"how": "as-is" | "remux" | "convert", "codec", "container",
    "duration"}. Raises ValueError when the file has no picture to show."""
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries",
                          "stream=codec_name,pix_fmt:stream_disposition=attached_pic:format=format_name,duration",
                          "-of", "default=nw=1", path],
                         capture_output=True, text=True, stdin=subprocess.DEVNULL, creationflags=NOWIN).stdout
    streams, info, cur = [], {}, {}
    for line in out.splitlines():
        key, _, value = line.partition("=")
        if key == "codec_name":
            cur = {"codec": value}
            streams.append(cur)
        elif key in ("pix_fmt", "DISPOSITION:attached_pic"):
            cur[key] = value
        elif key in ("format_name", "duration"):
            info[key] = value
    real = [s for s in streams if s.get("DISPOSITION:attached_pic") != "1"]   # a cover image does not count
    if not real:
        raise ValueError(NO_PICTURE)
    codec, pixels = real[0]["codec"], real[0].get("pix_fmt", "")
    container = info.get("format_name", "")
    duration = float(info["duration"]) if info.get("duration", "").replace(".", "", 1).isdigit() else 0.0
    if codec in PLAYS_CODECS and pixels in PLAYS_PIXELS:
        how = "as-is" if container.startswith(PLAYS_CONTAINERS) else "remux"
    else:
        how = "convert"
    return {"how": how, "codec": codec, "container": container, "duration": duration}


def part_seconds(duration):
    """Length of the first-part copy for a video this long, or 0 when the full copy alone is quick enough."""
    if duration <= FULL_ONLY_S:
        return 0
    return min(PART_MAX_S, max(PART_MIN_S, duration * PART_SHARE))


def _ffmpeg(src, dst, args, seconds, step, cancelled, before=()):
    """Runs one ffmpeg copy into dst (through a temporary file, so dst only ever exists complete).
    step(frac) follows the picture time written; raises RuntimeError on failure, Cancelled when stopped."""
    tmp = dst + ".part" + os.path.splitext(dst)[1]
    cmd = ["ffmpeg", "-v", "error", "-y", "-nostdin", *before, "-i", src] + (["-t", f"{seconds:.3f}"] if seconds else []) + \
          ["-map", "0:v:0", "-an", "-sn", "-dn"] + args + ["-progress", "pipe:1", "-nostats", tmp]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                         text=True, creationflags=NOWIN)
    err = []
    threading.Thread(target=lambda: err.extend(p.stderr), daemon=True).start()
    try:
        for line in p.stdout:
            if cancelled():
                p.kill()
                break
            if line.startswith("out_time_us=") and line[12:].strip().isdigit() and seconds:
                step(min(1.0, int(line[12:]) / 1e6 / seconds))
        p.wait()
        if cancelled():
            raise Cancelled()
        if p.returncode != 0 or not os.path.isfile(tmp):
            raise RuntimeError("ffmpeg could not copy the picture: " + "".join(err)[-300:].strip())
        os.replace(tmp, dst)
    finally:
        if p.poll() is None:
            p.kill()
            p.wait()
        _drop(tmp)


CONVERT = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
           "-vf", f"scale=-2:'min({COPY_HEIGHT},trunc(ih/2)*2)'", "-movflags", "+faststart"]
REMUX = ["-c:v", "copy"]
REMUX_IN = ["-fflags", "+genpts"]   # AVI frames carry no timestamps, MKV needs them


class Cancelled(Exception):
    pass


class Pictures:
    """Makes the player's picture, one video at a time, next to a running cleaning job (it uses the CPU, the
    cleaning mostly the graphics card: measured, a 9 min cleaning took 74 s instead of 70 s alongside).
    Starting a new one stops the old one (the player shows one video). Events "picture":
    {id, src, how, state: running / done / cancelled / error, frac, text, part, part_s, full}; `part` (a first-part
    copy, its length part_s) arrives before `full` for long videos that need converting; `full` is the file to
    play in the end (the original itself for "as-is")."""

    def __init__(self, emit):
        self.emit = emit
        self.item = None
        self._cancel = threading.Event()
        self._lock = threading.Lock()
        self._ids = 0
        self._worker = None
        self._sent = 0.0

    def start(self, spec):
        """spec: {"src", "folder", "how"?}. how="convert" forces a converted copy (the player asks for it when the
        browser could not play a file it was expected to play, e.g. HEVC on a PC without an HEVC decoder).
        Returns the new item; raises ValueError for a bad spec or a file with no picture."""
        src, folder = spec.get("src"), spec.get("folder")
        if not src or not folder:
            raise ValueError("src and folder are needed")
        if not os.path.isfile(src):
            raise ValueError(f"File not found: {src}")
        cur = self.item
        if not spec.get("how") and cur and cur["src"] == src and cur.get("folder") == folder and \
                cur["state"] in ("running", "done"):
            return dict(cur)   # the player asks again for the picture it is making or made (one per video)
        info = plan(src)
        if spec.get("how") == "convert":
            info["how"] = "convert"
        elif spec.get("how"):
            raise ValueError('how can only be "convert"')
        if self.item and self.item["state"] == "running":   # stop the old one first (outside the lock: it updates)
            self._cancel.set()
            self._worker.join()
        with self._lock:
            self._cancel = threading.Event()
            self._ids += 1
            self.item = dict(info, id=self._ids, src=src, folder=folder, state="running", frac=0.0, text="Preparing the picture…",
                             part=None, part_s=0, full=None)
            if info["how"] == "as-is":
                self.item.update(state="done", frac=1.0, text="Done", full=src)
            item = dict(self.item)
            if info["how"] != "as-is":
                self._worker = threading.Thread(target=self._run, args=(item, folder, self._cancel), daemon=True)
                self._worker.start()
        self._send(force=True)
        return item

    def stop(self, item_id):
        if not self.item or self.item["id"] != item_id or self.item["state"] != "running":
            return False
        self._cancel.set()
        return True

    def get(self, item_id):
        return dict(self.item) if self.item and self.item["id"] == item_id else None

    def _update(self, item_id, force=False, **change):
        with self._lock:
            if not self.item or self.item["id"] != item_id:
                return
            self.item.update(change)
        self._send(force)

    def _send(self, force=False):
        now = time.monotonic()
        if force or now - self._sent >= PROGRESS_EVERY_S:
            self._sent = now
            with self._lock:
                item = dict(self.item)
            self.emit("picture", item)

    def _run(self, item, folder, cancel):
        item_id, src, how = item["id"], item["src"], item["how"]
        os.makedirs(folder, exist_ok=True)
        full = os.path.join(folder, "picture.mkv" if how == "remux" else "picture.mp4")
        part = os.path.join(folder, "picture_part.mp4")
        try:
            if how == "remux":
                if not os.path.isfile(full):
                    _ffmpeg(src, full, REMUX, 0, lambda f: None, cancel.is_set, REMUX_IN)
            elif not os.path.isfile(full):
                part_s = part_seconds(item["duration"])
                share = part_s / (part_s + item["duration"]) if part_s else 0   # of all the work, for frac

                def step(a, b):
                    return lambda f: self._update(item_id, frac=a + (b - a) * f,
                                                  text=f"Preparing the picture… {(a + (b - a) * f) * 100:.0f}%")
                if part_s:
                    if not os.path.isfile(part):
                        _ffmpeg(src, part, CONVERT, part_s, step(0, share), cancel.is_set)
                    self._update(item_id, force=True, part=part, part_s=part_s)
                _ffmpeg(src, full, CONVERT, item["duration"], step(share, 1), cancel.is_set)
            _drop(part)   # the full copy replaces it (while the player still reads it Windows keeps it: next play)
            self._update(item_id, force=True, state="done", frac=1.0, text="Done", full=full)
        except Exception as ex:
            if cancel.is_set():
                self._update(item_id, force=True, state="cancelled", text="Cancelled.")
            else:
                self._update(item_id, force=True, state="error", text=NO_PICTURE, detail=str(ex))


def _drop(path):
    try:
        os.remove(path)
    except OSError:
        pass
