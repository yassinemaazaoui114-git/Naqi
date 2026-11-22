"""Save, the last and optional step of the player (ROADMAP T4.3, old SPEC R14e): a played library item becomes an
MP3 or MP4 in the day folder, made from its cleaned-sound cache (cleaned.wav), nothing cleaned again. An MP4 of an
own video takes the picture from the file (copied, or shrunk to the chosen size); an MP4 of a link downloads the
video now (picture only, the chosen size as the site offers it), joins it with the cleaned sound, then deletes the
download. The history row remembers every saved file (`saved` column), so the library item plays a saved file once
its cache is tidied away. Old Naqi's save_item / save_job, without Qt.
One Save at a time, next to a cleaning job (it uses the CPU and the network, the cleaning the graphics card), with
Cancel: no half-written file and no downloaded video are left. Events "save":
{id, row_id, fmt, state: running / done / cancelled / error, frac, text, path}.
"""
import datetime
import glob
import os
import threading
import time

import files
import history

VIDEO_SIZES = ("Original", "1080p", "720p", "480p")   # old Naqi VIDEO_SIZES
MP3_KBPS = (128, 192, 320)
MP4_AUDIO_KBPS = 192        # audio bitrate of a cleaned MP4 (old Naqi)
DOWNLOAD_SHARE = 0.7        # part of the progress bar a link's video download takes (old Naqi)
PROGRESS_EVERY_S = 0.25


class Busy(Exception):
    pass


def can_save(r, live_id=None):
    """(ok, why): a played item can be saved once all of it is clean; a saved file is saved already."""
    if not history.is_cache(r["result"]):
        return False, "It is saved already."
    if r["id"] != live_id and not history.has_cache(r) and history.saved_files(r):
        return False, "Saved already. Its cleaned sound was tidied away, so it cannot be saved in another way."
    if r["id"] == live_id or not history.has_cache(r):
        return False, "Save is ready when all of it is clean."
    return True, ""


def has_picture(r):
    """Can it become an MP4: a link, or an own video that is still there."""
    return files.is_link(r["source"]) or (r["source"].lower().endswith(files.VIDEO_EXTS) and os.path.isfile(r["source"]))


class Saves:
    def __init__(self, emit):
        self.emit = emit
        self.item = None
        self._cancel = threading.Event()
        self._lock = threading.Lock()
        self._ids = 0
        self._sent = 0.0

    def start(self, row_id, spec, live_id=None):
        """spec: {"fmt": "mp3" | "mp4", "size"?: one of VIDEO_SIZES, "kbps"?: 128 / 192 / 320, "out": the folder
        the day folder is made in}. Returns the new item; raises ValueError (a message for the page) or Busy."""
        r = history.get_row(row_id)
        if not r:
            raise ValueError("Not in the library any more.")
        fmt, size, out = spec.get("fmt"), spec.get("size") or "Original", spec.get("out")
        kbps = int(str(spec.get("kbps") or 192).split()[0])
        if fmt not in ("mp3", "mp4") or size not in VIDEO_SIZES or kbps not in MP3_KBPS or not out:
            raise ValueError("fmt, size, kbps or out is not right")
        ok, why = can_save(r, live_id)
        if not ok:
            raise ValueError(why)
        if fmt == "mp4" and not has_picture(r):
            raise ValueError("There is no picture to save. Save it as MP3.")
        with self._lock:
            if self.item and self.item["state"] == "running":
                raise Busy("Another file is being saved…")
            self._cancel = threading.Event()
            self._ids += 1
            link_mp4 = fmt == "mp4" and files.is_link(r["source"])
            self.item = {"id": self._ids, "row_id": row_id, "fmt": fmt, "state": "running", "frac": 0.0,
                         "text": "Downloading the video…" if link_mp4 else "Saving…", "path": None}
            item = dict(self.item)
        out = os.path.join(out, datetime.date.today().isoformat())   # the day folder, like every save
        threading.Thread(target=self._run, args=(item["id"], r, out, fmt, size, kbps, self._cancel),
                         daemon=True).start()
        self._send(force=True)
        return item

    def stop(self, save_id):
        if not self.item or self.item["id"] != save_id or self.item["state"] != "running":
            return False
        self._cancel.set()
        return True

    def stop_all(self, wait_s=2.5):
        """The engine is stopping: a running Save is cancelled and given a moment to delete its half file."""
        if not self.item or self.item["state"] != "running":
            return
        self._cancel.set()
        end = time.monotonic() + wait_s
        while self.item["state"] == "running" and time.monotonic() < end:
            time.sleep(0.05)

    def get(self, save_id):
        return dict(self.item) if self.item and self.item["id"] == save_id else None

    def _update(self, save_id, force=False, **change):
        with self._lock:
            if not self.item or self.item["id"] != save_id:
                return
            self.item.update(change)
        self._send(force)

    def _send(self, force=False):
        now = time.monotonic()
        if force or now - self._sent >= PROGRESS_EVERY_S:
            self._sent = now
            with self._lock:
                item = dict(self.item)
            self.emit("save", item)

    def _run(self, save_id, r, out, fmt, size, kbps, cancel):
        import downloads
        import speech_only
        from yt_dlp.utils import DownloadCancelled

        def hook(d):
            if cancel.is_set():
                raise DownloadCancelled("Cancelled by user")
            if d["status"] == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                frac = DOWNLOAD_SHARE * d["downloaded_bytes"] / total if total else 0.0
                self._update(save_id, frac=frac, text=f"Downloading the video… {frac * 100:.0f}%")

        def progress(frac):
            self._update(save_id, frac=frac, text=f"Saving… {frac * 100:.0f}%")

        try:
            path = os.path.normpath(save_item(r, out, fmt, size, kbps, hook, progress, cancel.is_set))
            history.add_saved(r["id"], path)
            self._update(save_id, force=True, state="done", frac=1.0, path=path,
                         text="Saved: " + os.path.basename(path))
        except Exception as ex:
            if cancel.is_set() or isinstance(ex, (DownloadCancelled, speech_only.Cancelled)):
                self._update(save_id, force=True, state="cancelled", text="Not saved.")
            else:
                self._update(save_id, force=True, state="error",
                             text="Not saved: " + downloads.link_error(str(ex) or type(ex).__name__))


def save_item(r, out, fmt, size, kbps, hook, progress, cancel):
    """History row `r` (a played item whose cleaned-sound cache is there) becomes an MP3 or MP4 in the folder `out`
    (old Naqi save_item, unchanged). size: one of VIDEO_SIZES; kbps: MP3 quality. Returns the saved file's path."""
    import downloads
    import speech_only
    source, video, folder = r["source"], None, history.history_folder(r)
    height = None if size == "Original" else int(size.rstrip("p"))
    try:
        if files.is_link(source):
            tags = {"title": r["title"], "purl": source, "comment": source}   # the report page finds the link again
            if fmt == "mp4":
                video = downloads.download_video(source, folder, height, hook)
                height = None   # the site's own size (720p of a vertical Short is 720 wide): never shrunk again
            src = video or (r["sound"] if r["sound"] and os.path.isfile(r["sound"]) else None)
        elif os.path.isfile(source):
            tags, src = {}, source
        else:
            raise RuntimeError(f"File not found: {source}")
        name = r["title"] if files.is_link(source) else os.path.splitext(r["title"] or os.path.basename(source))[0]
        os.makedirs(out, exist_ok=True)
        dst = files.unique_path(os.path.join(out, files.file_name(name) + "." + fmt))
        share = DOWNLOAD_SHARE if video else 0.0   # the download already took this part of the progress bar
        speech_only.save_wav(dst, r["result"], MP4_AUDIO_KBPS if fmt == "mp4" else kbps,
                             lambda f: progress(share + f * (1 - share)), cancel, src, height, tags)
        return dst
    finally:
        if files.is_link(source) and fmt == "mp4" and folder:   # the downloaded picture (or what a cancel left)
            for f in glob.glob(os.path.join(folder, "video.*")):
                try:
                    os.remove(f)
                except OSError:
                    pass
