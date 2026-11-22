"""Cleaning jobs (ROADMAP T0.5): "clean a sound" and "clean a file", run one at a time in a worker thread, with
progress, cancel and a finish event. The cleaning itself is speech_only.py, unchanged (GPU first, CPU fallback):
- "sound": clean_to_wav, chunk by chunk (2 / 5 / 15 min) into a WAV file (cleaned.wav), so it can play while it is
  cleaned (old Naqi job_play). Extra field in its events: ready_s (seconds clean from the start), plays.
- "file": clean_file, the sound of `src` without music written to `dst` (MP3, or MP4 with the picture), the
  original never changed.
- "files" (Home, own files): each one cleaned into the day folder `out/YYYY-MM-DD`, one after the other (old Naqi
  job_files); a file that fails is reported and the next one goes on.
- "link" (Home, a video link or a whole YouTube playlist): downloaded with yt-dlp into the day folder and cleaned in
  place right after (old Naqi job + SpeechOnlyPP); its original sound is kept in the history (2 weeks / 5 GB).
  "files" and "link" write one history row per cleaned file and tidy the history at the end, like old Naqi. Extra
  fields in their events: saved (cleaned files), done (their sources), failed, last (newest file), outcome (done,
  partial or error, as old Naqi's summaries).
Every change is sent as a "job" event: {id, kind, state, frac, text, ...}; state is running, done, cancelled or
error. A finished job also carries `numbers` (time, speed, device, peak VRAM) and `result` (the file made).
"""
import datetime
import itertools
import os
import shutil
import threading
import time

import files
import history

MP4_AUDIO_KBPS = 192      # audio bitrate of a cleaned MP4 (old Naqi)

PROGRESS_EVERY_S = 0.25   # progress events at most this often (the last one always goes out)
_ids = itertools.count(1)


class Busy(Exception):
    pass


class Jobs:
    def __init__(self, emit, on_play=None):
        self.emit = emit
        self.on_play = on_play     # on_play(row_id): a "Clean and play" item's row exists (its picture is looked up)
        self.job = None            # the running job, or the last one
        self.cancel = threading.Event()
        self._lock = threading.Lock()
        self._sent = 0.0

    def start(self, spec):
        """spec: {"kind": "sound", "src", "wav"}, {"kind": "file", "src", "dst", "kbps"?, "height"?},
        {"kind": "files", "files": [paths], "out", "fmt": "mp4" | "mp3", "height"?, "kbps"?} or
        {"kind": "link", "url", "out", "fmt": "mp4" | "mp3", "quality"?, "playlist"?} (out: the folder the day
        folder is made in), {"kind": "play", "source"} or {"kind": "play", "row"} (a library item whose cleaned
        sound was tidied away, cleaned again into the same row). Returns the new job. Raises ValueError for a bad
        spec, Busy while another job runs."""
        kind = spec.get("kind")
        if kind == "play" and spec.get("row") is not None:
            r = history.get_row(int(spec["row"]))
            if not r:
                raise ValueError("Not in the library any more.")
            spec = dict(spec, row=r, source=r["source"])
        need = {"sound": ("src", "wav"), "file": ("src", "dst"), "files": ("files", "out"),
                "link": ("url", "out"), "play": ("source",)}.get(kind)
        if not need:
            raise ValueError('kind must be "sound", "file", "files", "link" or "play"')
        if kind == "play" and not files.is_link(str(spec["source"]).strip()) and not os.path.isfile(spec["source"]):
            raise ValueError(f"File not found: {spec['source']}")
        for key in need:
            if not spec.get(key):
                raise ValueError(f"{key} is missing")
        sources = spec["files"] if kind == "files" else [spec["src"]] if "src" in need else []
        for src in sources if isinstance(sources, list) else [sources]:
            if not isinstance(src, str) or not os.path.isfile(src):
                raise ValueError(f"File not found: {src}")
        if kind == "link" and not files.is_link(str(spec["url"]).strip()):
            raise ValueError("This does not look like a link. It should start with https://")
        with self._lock:
            if self.job and self.job["state"] == "running":
                raise Busy("Another cleaning is still running.")
            self.cancel.clear()
            self.job = {"id": next(_ids), "kind": kind, "state": "running", "frac": 0.0,
                        "text": "Removing music… 0%", "started": time.time()}
            if kind in ("sound", "play"):
                self.job.update(ready_s=0.0, plays=False)
            if kind == "play":
                self.job.update(text="Starting…", row_id=None, wav=None, title="", total_s=None)
            if kind in ("files", "link"):
                self.job.update(text="Starting…", saved=[], done=[], failed=[], last=None)
            job = dict(self.job)
        threading.Thread(target=self._run, args=(job["id"], spec), daemon=True).start()
        self._send(force=True)
        return job

    def stop(self, job_id):
        """Ask the running job to stop; it ends as "cancelled" at its next progress step. False if not running."""
        if not self.job or self.job["id"] != job_id or self.job["state"] != "running":
            return False
        self.cancel.set()
        return True

    def stop_all(self, wait_s=1.2):
        """The engine is stopping (old Naqi's closeEvent): a running job is cancelled and given a moment to delete
        its half-made file, so no file with the music still in it is left in the day folder."""
        if not self.job or self.job["state"] != "running":
            return
        self.cancel.set()
        end = time.monotonic() + wait_s
        while self.job["state"] == "running" and time.monotonic() < end:
            time.sleep(0.05)

    def get(self, job_id):
        return dict(self.job) if self.job and self.job["id"] == job_id else None

    def _update(self, job_id, force=False, **change):
        with self._lock:
            if not self.job or self.job["id"] != job_id:
                return
            self.job.update(change)
        self._send(force)

    def _send(self, force=False):
        now = time.monotonic()
        if force or now - self._sent >= PROGRESS_EVERY_S:
            self._sent = now
            with self._lock:
                job = dict(self.job)
            self.emit("job", job)

    def _run(self, job_id, spec):
        if spec["kind"] in ("files", "link"):
            return self._run_home(job_id, spec)
        if spec["kind"] == "play":
            return self._run_play(job_id, spec)
        import speech_only   # heavy (PyTorch); already loaded by the server's start-up
        cancelled = self.cancel.is_set

        def step(frac):
            self._update(job_id, frac=frac, text=f"Removing music… {frac * 100:.0f}%")

        def ready(seconds, plays):
            self._update(job_id, force=True, ready_s=seconds, plays=plays)

        result = spec["wav"] if spec["kind"] == "sound" else spec["dst"]
        try:
            os.makedirs(os.path.dirname(os.path.abspath(result)), exist_ok=True)
            if spec["kind"] == "sound":
                numbers = speech_only.clean_to_wav(spec["src"], result, step, cancelled, ready)
            else:
                numbers = speech_only.clean_file(result, int(spec.get("kbps") or 192), step, cancelled,
                                                 src=spec["src"], height=spec.get("height"))
            self._update(job_id, force=True, state="done", frac=1.0, text="Done", result=result, numbers=numbers)
        except Exception as ex:
            _drop(result)   # never leave a half-cleaned file, or one with the music still in it
            if cancelled():   # speech_only.Cancelled, or an error caused by stopping
                self._update(job_id, force=True, state="cancelled", text="Cancelled.")
            else:
                self._update(job_id, force=True, state="error", text=str(ex) or type(ex).__name__)

    def _played(self, row_id):
        if self.on_play:
            try:
                self.on_play(row_id)
            except Exception:
                pass   # no picture: the sound still plays

    def _run_home(self, job_id, spec):
        """The Home page's jobs: everything cleaned is saved into the day folder and gets a history row."""
        out = os.path.join(spec["out"], datetime.date.today().isoformat())   # one folder per day (old SPEC R10)
        top = [0.0]   # progress never moves backwards inside one job

        def progress(frac, text):
            top[0] = max(top[0], frac)
            self._update(job_id, frac=top[0], text=text)

        def saved(src, dst, title, sound, numbers):
            try:
                history.add_history(src, title, sound, dst)
            except Exception:
                history.drop_sound(sound)   # no history this time; the cleaned file itself is fine
            dst = os.path.normpath(dst)
            with self._lock:
                job = self.job
                job.update(saved=job["saved"] + [dst], done=job["done"] + [src], last=dst, numbers=numbers)
            self._send(force=True)

        def failed(names):
            self._update(job_id, force=True, failed=names)

        try:
            os.makedirs(out, exist_ok=True)
            if spec["kind"] == "files":
                outcome, message = _clean_files(spec, out, progress, saved, failed, self.cancel.is_set)
            else:
                outcome, message = _clean_link(spec, out, progress, saved, self.cancel.is_set)
            if self.cancel.is_set():
                raise RuntimeError("cancelled")
            done = outcome != "error"
            self._update(job_id, force=True, state="done" if done else "error", outcome=outcome, text=message,
                         frac=1.0 if done else top[0], result=self.job.get("last"))
        except Exception as ex:
            if self.cancel.is_set():
                self._update(job_id, force=True, state="cancelled",
                             text="Cancelled. Files that were already finished were kept.")
            else:
                import downloads
                text = downloads.link_error(str(ex)) if spec["kind"] == "link" else str(ex)
                self._update(job_id, force=True, state="error", outcome="error", text=text or type(ex).__name__)
        finally:
            try:
                history.clean_history()
            except Exception:
                pass


    def _run_play(self, job_id, spec):
        """One link or one own file, cleaned and kept, nothing saved (old Naqi job_play; Save as comes from the
        player). A link's sound is downloaded into its history folder (it is also the kept original); the sound is
        cleaned chunk by chunk into cleaned.wav next to it; the history row is marked ready when all of it is clean.
        spec["row"]: a library item cleaned again (its folder and kept sound are used again). A new item that does
        not finish leaves nothing behind."""
        import downloads
        import speech_only
        row = spec.get("row")
        source = spec["source"].strip() if files.is_link(spec["source"].strip()) else spec["source"]
        cancelled = self.cancel.is_set
        made = folder = None
        top = [0.0]

        def progress(frac, text):
            top[0] = max(top[0], frac)
            self._update(job_id, frac=top[0], text=text)

        try:
            folder = history.history_folder(row) if row else None
            if not folder or not os.path.isdir(folder):
                folder = history.new_history_folder()
            sound = row["sound"] if row and row["sound"] and os.path.isfile(row["sound"]) else None
            title, share = (row["title"] if row else os.path.basename(source)), 0.0
            if row and not files.is_link(source) and not os.path.isfile(source):
                raise RuntimeError(f"File not found: {source}")
            cache = os.path.normpath(os.path.join(folder, history.CACHE_NAME))
            if row:   # known at once: its picture is looked up while the sound is downloaded
                history.restart_row(row["id"], sound, cache)
                self._update(job_id, force=True, row_id=row["id"], wav=cache, title=title)
                self._played(row["id"])
            if files.is_link(source) and not sound:
                progress(0, "Downloading the sound…")
                hook = downloads.progress_hook(lambda f, text, info: progress(f, text), cancelled,
                                               share=downloads.SOUND_SHARE, text="Downloading the sound…",
                                               finished=None)
                sound, got = downloads.download_sound(source, folder, hook)
                title, share = (row["title"] if row else got), downloads.SOUND_SHARE
                if row:
                    history.restart_row(row["id"], sound, cache)
            src = sound or source
            if not row:
                made = history.add_history(source, title, sound, cache, ready=0)
            row_id = row["id"] if row else made
            self._update(job_id, force=True, row_id=row_id, wav=cache, title=title,
                         total_s=speech_only.duration_of(src))
            if not row:
                self._played(row_id)
            state = {"ready_s": 0.0, "plays": False}

            def step(frac):
                tail = " It plays when the first part is clean." if not state["ready_s"] else \
                    " It plays when all of it is clean: this PC cleans slower than it plays." if not state["plays"] \
                    else ""
                progress(share + frac * (1 - share), f"Removing music… {frac * 100:.0f}%.{tail}")

            def ready(seconds, plays):
                state.update(ready_s=seconds, plays=plays)
                self._update(job_id, force=True, ready_s=seconds, plays=plays)

            numbers = speech_only.clean_to_wav(src, cache, step, cancelled, ready)
            history.mark_ready(row_id)
            self._update(job_id, force=True, state="done", outcome="played", frac=1.0, result=cache, numbers=numbers,
                         text=f"{title} stays in your library.")
        except Exception as ex:
            if made:
                try:
                    history.delete_row(made)
                except Exception:
                    pass
            if folder and not row:
                shutil.rmtree(folder, ignore_errors=True)
            elif row:   # cleaned again but not finished: its half cache goes (the kept sound stays), it cleans again
                _drop(os.path.join(folder, history.CACHE_NAME))
            if cancelled():
                self._update(job_id, force=True, state="cancelled", text="Cancelled.")
            else:
                self._update(job_id, force=True, state="error", text=downloads.link_error(str(ex)) or type(ex).__name__)
        finally:
            try:
                history.clean_history()
            except Exception:
                pass


def _clean_files(spec, out, progress, saved, failed_now, cancelled):
    """Own files, one after the other (old Naqi job_files); the originals are never changed. A file that fails is
    reported and the next one goes on. Returns (outcome, message) like old Naqi's summarize_files."""
    import speech_only
    paths = spec["files"]
    n, failed, last = len(paths), [], None
    fmt, height, kbps = spec.get("fmt", "mp4"), spec.get("height"), int(spec.get("kbps") or 192)
    for i, src in enumerate(paths):
        name = os.path.basename(src)
        prefix = f"File {i + 1} of {n}: " if n > 1 else ""

        def step(frac, i=i, prefix=prefix):
            progress((i + frac) / n, f"{prefix}Removing music… {frac * 100:.0f}%")

        try:
            # No picture in the file (MP3, WAV...): the result can only be audio
            video = fmt == "mp4" and speech_only.video_codec(src)
            dst = files.unique_path(os.path.join(out, os.path.splitext(name)[0] + (".mp4" if video else ".mp3")))
            numbers = speech_only.clean_file(dst, MP4_AUDIO_KBPS if video else kbps, step, cancelled, src=src,
                                             height=height)
            last = dst
            saved(src, dst, name, None, numbers)   # own file: no copy, the original stays where it is
        except speech_only.Cancelled:
            raise
        except Exception as ex:
            if cancelled():
                raise
            failed.append(f"{name}: {ex}")
            failed_now(list(failed))
    if not failed:
        return "done", os.path.basename(last) if n == 1 else f"{n} files"
    if len(failed) == n:
        return "error", failed[-1]
    return "partial", f"{n - len(failed)} of {n} files. Failed: {failed[0]}"


def _clean_link(spec, out, progress, saved, cancelled):
    """A link (one video, or a whole YouTube playlist): yt-dlp downloads each video as MP3 or MP4 into the day
    folder, and each one is cleaned in place right after its download (old Naqi job + SpeechOnlyPP).
    Returns (outcome, message) like old Naqi's summarize. When nothing came because the site has changed, it is
    tried once more with a newer yt-dlp (if there is one, ytdlp_update)."""
    import downloads
    import ytdlp_update
    try:
        (outcome, message), error = _clean_link_once(spec, out, progress, saved, cancelled)
    except Exception as ex:
        if cancelled() or not downloads.site_changed(str(ex)) or not ytdlp_update.fresh():
            raise
    else:
        if outcome != "error" or cancelled() or not downloads.site_changed(error) or not ytdlp_update.fresh():
            return outcome, message
    return _clean_link_once(spec, out, progress, saved, cancelled)[0]


def _clean_link_once(spec, out, progress, saved, cancelled):
    """One try of _clean_link, with the yt-dlp in use now. Returns ((outcome, message), yt-dlp's last error)."""
    import speech_only
    import yt_dlp
    from yt_dlp.postprocessor import PostProcessor
    from yt_dlp.utils import DownloadCancelled
    import downloads

    url, fmt = spec["url"].strip(), spec.get("fmt", "mp4")
    quality = spec.get("quality") or ("192 kbps" if fmt == "mp3" else "1080p")
    playlist = downloads.is_playlist_only(url) or (bool(spec.get("playlist")) and downloads.is_playlist_link(url))
    kbps = int(quality.split()[0]) if fmt == "mp3" else MP4_AUDIO_KBPS

    def report(frac, text, info):
        progress(*downloads.playlist_progress(info, frac, text))

    class SpeechOnlyPP(PostProcessor):
        """Runs after a file is fully downloaded/converted: replaces its sound with the same sound without music."""
        def run(self, info):
            path = info["filepath"]
            sound = history.keep_sound(path)   # before the file is cleaned in place
            share = downloads.DOWNLOAD_SHARE

            def step(frac):
                report(share + frac * (1 - share), f"Removing music… {frac * 100:.0f}%", info)

            try:
                numbers = speech_only.clean_file(path, kbps, step, cancelled)
            except speech_only.Cancelled:
                history.drop_sound(sound)
                _drop(path)
                raise DownloadCancelled("Cancelled by user")
            except Exception:
                history.drop_sound(sound)
                _drop(path)   # never leave a file with the music still in it
                raise
            saved(info.get("webpage_url") or info.get("original_url") or url, path, info.get("title") or "", sound,
                  numbers)
            return [], info

    log = downloads.ErrorLog()
    hook = downloads.progress_hook(report, cancelled)
    with yt_dlp.YoutubeDL(downloads.build_opts(out, fmt, quality, playlist, hook, log)) as ydl:
        ydl.add_post_processor(SpeechOnlyPP(), when="post_process")
        try:
            info = ydl.extract_info(url, download=True) if playlist else downloads.extract(ydl, url)
        except DownloadCancelled:
            raise RuntimeError("cancelled") from None   # _run_home sees the cancel flag
    return downloads.summarize(info, fmt, playlist, log.errors), (log.errors[-1] if log.errors else "")


def _drop(path):
    try:
        os.remove(path)
    except OSError:
        pass
