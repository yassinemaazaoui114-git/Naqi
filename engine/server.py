"""Naqi engine sidecar: a small local server the Electron window talks to (SPEC R4).
Listens only on 127.0.0.1, on a port the system picks, and answers only requests that carry the token Electron
gave it in the NAQI_TOKEN environment variable. Standard library only, so it adds nothing to install.
On start it prints one line to stdout: {"port": <port>}. It stops on POST /shutdown, and by itself when the
Electron process (NAQI_PARENT_PID) ends, so it never outlives the window.
Routes: GET /health (state, the yt-dlp and Python versions in use), GET /gpu (graphics card), GET /events (event stream, server-sent events),
POST /jobs (start a cleaning job, JSON body as in jobs.Jobs.start), GET /jobs/<id>, POST /jobs/<id>/cancel,
POST /kinds (audio or video per file), POST /pictures (a video's picture for the player, body as in picture.Pictures.start), GET /pictures/<id>,
POST /pictures/<id>/cancel, GET /library (the side bar's items), POST /library/<id>/remove, POST /library/<id>/rate,
GET /library/<id>/wave (the shape of its cleaned sound, for the report page's sound strip), GET /library/<id>/muted
(where it was muted, for the player's time bar; while it is cleaned, the clean part).
Save (saves.py): POST /library/<id>/save ({fmt, size, kbps, out}: MP3 / MP4 from its cleaned sound), GET /saves/<id>,
POST /saves/<id>/cancel.
Report a slip (cases.py): GET /cases (how many are saved), POST /cases/source ({row} or {path}: what the report is
about), POST /cases (save one: the sound is copied or downloaded, so the answer can take a while).
Player (player.py): POST /player/<id> (open a library item: what to play and its picture), POST /player/<id>/convert
(the browser could not show the picture as it is), POST /player/<id>/stream (the site refused the stream address:
look it up again), POST /player/<id>/quality {"height": null | 1080 | 720 | 480 | 360} (a link's picture size); media for the page's <audio> and <video>, with byte ranges: GET /media/<id>/sound (the clean part
only, while it is cleaned), GET /media/pictures/<picture id>/part | full, GET /media/stream/<id> (a link's picture).
Settings (T11.2): GET /keep (the keep rule and the space kept sounds take), POST /keep {"days", "gb"} (a new rule; it
is applied at once when nothing runs). NAQI_DEVICE=cpu starts the engine on the CPU even with a graphics card.
"""
import ctypes
import hmac
import json
import os
import platform
import queue
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

if getattr(sys, "frozen", False):   # the installed engine (T7.1): ffmpeg, ffprobe and deno come with it, in bin\
    os.environ["PATH"] = os.path.join(sys._MEIPASS, "bin") + os.pathsep + os.environ.get("PATH", "")

# Settings: CPU only (T11.2). PyTorch then sees no graphics card, before any module loads it
CPU_CHOSEN = os.environ.get("NAQI_DEVICE") == "cpu"
if CPU_CHOSEN:
    os.environ["CUDA_VISIBLE_DEVICES"] = "-1"   # "" is not enough for this PyTorch

import ytdlp_update  # noqa: E402

ytdlp_update.use_newest()   # before any module imports yt_dlp
import cases  # noqa: E402
import files  # noqa: E402
import history  # noqa: E402
import jobs  # noqa: E402
import library  # noqa: E402
import picture  # noqa: E402
import player  # noqa: E402
import saves  # noqa: E402

HEARTBEAT_S = 15   # an empty comment line on the event stream this often, so a dead connection is noticed
MAX_BODY = 64 * 1024
MEDIA_CHUNK = 256 * 1024
_sizes = {}                      # cleaned.wav path -> the largest size the player was told (_send_file keep_size)
_sizes_lock = threading.Lock()
MEDIA_TYPES = {".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "video/mp4",
               ".m4v": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".webm": "video/webm"}

TOKEN = os.environ.get("NAQI_TOKEN", "")
_state = {"state": "starting", "error": None, "pid": os.getpid(), "models": False}   # models: loaded in memory
_gpu = {}
_clients = []
_clients_lock = threading.Lock()


def emit(event, data):
    """Send one event to every open event stream."""
    with _clients_lock:
        for q in _clients:
            q.put((event, data))


_pictures = picture.Pictures(emit)   # runs next to a cleaning job, not after it
_player = player.Player(emit, _pictures)
_jobs = jobs.Jobs(emit, on_play=_player.prepare)   # "Clean and play" finds its picture while its sound is cleaned
_saves = saves.Saves(emit)   # one Save at a time, next to a cleaning job


def _live_id():
    """The history row "Clean and play" is cleaning right now, or None."""
    job = _jobs.job
    return job.get("row_id") if job and job["state"] == "running" else None


def _idle():
    """Nothing is downloading or cleaning right now (a newer yt-dlp can be swapped in)."""
    job, save = _jobs.job, _saves.item
    return not (job and job["state"] == "running") and not (save and save["state"] == "running")


def _set_state(state, error=None):
    _state.update(state=state, error=error)
    emit("state", dict(_state))


def _start_up():
    """Load PyTorch and check the model files in the background, so /health answers right away."""
    try:
        import torch
        import speech_only
        cuda = torch.cuda.is_available()
        _gpu.update(device="cuda" if cuda else "cpu", name=speech_only.device_name(), torch=torch.__version__,
                    cuda=torch.version.cuda if cuda else None,
                    vram_total_mb=round(torch.cuda.get_device_properties(0).total_memory / 2**20) if cuda else None,
                    chosen="cpu" if CPU_CHOSEN else "auto")
        emit("gpu", dict(_gpu))
        for name in speech_only.MODEL_FILES.values():
            speech_only._model_file(name)   # raises a clear message when a model file is missing
        try:
            history.clean_history()   # the 2 weeks / 5 GB rule, also when the app was closed for a while (old Naqi)
        except Exception:
            pass
        _set_state("ready")
        speech_only.warm_up()   # load the models now, like old Naqi, so the first job starts right away
        _state["models"] = True
        emit("state", dict(_state))
        try:
            ytdlp_update.daily(_idle)   # a newer yt-dlp once a day, used at once if nothing is running
        except Exception:
            pass   # links still work with the yt-dlp there is
    except Exception as e:   # shown in the window as a message, never a crash
        _set_state("error", f"{type(e).__name__}: {e}")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):   # keep stderr for real errors only
        pass

    def _allowed(self):
        given = self.headers.get("Authorization", "")
        if TOKEN and hmac.compare_digest(given, "Bearer " + TOKEN):
            return True
        self._json({"error": "forbidden"}, 403)
        return False

    def _json(self, data, code=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._allowed():
            return
        if self.path == "/health":
            self._json({**_state, "ytdlp": ytdlp_update.version(), "python": platform.python_version(), "busy": not _idle()})
        elif self.path == "/gpu":
            self._json(_gpu)
        elif self.path == "/events":
            self._events()
        elif self._job_path():
            job = _jobs.get(self._job_path()[0])
            self._json(job or {"error": "no such job"}, 200 if job else 404)
        elif self._job_path("pictures"):
            item = _pictures.get(self._job_path("pictures")[0])
            self._json(item or {"error": "no such picture"}, 200 if item else 404)
        elif self._job_path("saves"):
            item = _saves.get(self._job_path("saves")[0])
            self._json(item or {"error": "no such save"}, 200 if item else 404)
        elif self.path == "/library":
            self._json({"items": library.items(_live_id())})
        elif self._job_path("library") and self._job_path("library")[1] == "wave":
            self._wave(self._job_path("library")[0])
        elif self._job_path("library") and self._job_path("library")[1] == "muted":
            self._muted(self._job_path("library")[0])
        elif self.path == "/cases":
            self._json({"count": len(cases.read_cases())})
        elif self.path == "/keep":
            self._json(history.keep_rule())
        elif self.path.startswith("/media/"):
            self._media(self.path.split("?")[0].strip("/").split("/")[1:])
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        # The body is always read, also by routes that ignore it: bytes left unread on a kept-alive connection
        # would be taken as the start of the next request
        size = int(self.headers.get("Content-Length") or 0)
        self._raw = self.rfile.read(size) if size <= MAX_BODY else None
        self.close_connection = self._raw is None   # too large: not read, so this connection cannot be reused
        if not self._allowed():
            return
        if self.path == "/shutdown":
            self._json({"ok": True})
            threading.Thread(target=lambda: (time.sleep(0.1), _jobs.stop_all(), _saves.stop_all(1.2), os._exit(0)), daemon=True).start()
        elif self.path == "/jobs":
            self._start_job()
        elif self._job_path() and self._job_path()[1] == "cancel":
            self._json({"ok": _jobs.stop(self._job_path()[0])})
        elif self.path == "/kinds":
            self._kinds()
        elif self.path == "/pictures":
            self._start_picture()
        elif self._job_path("pictures") and self._job_path("pictures")[1] == "cancel":
            self._json({"ok": _pictures.stop(self._job_path("pictures")[0])})
        elif self._job_path("library") and self._job_path("library")[1] == "remove":
            try:
                self._json({"ok": library.remove(self._job_path("library")[0], _live_id())})
            except ValueError as e:
                self._json({"error": str(e)}, 409)
        elif self._job_path("library") and self._job_path("library")[1] == "rate":
            try:
                self._json(library.rate(self._job_path("library")[0], self._body().get("rating"), _live_id()))
            except (ValueError, AttributeError) as e:   # bad JSON, a bad rating, or an item that is not there
                self._json({"error": str(e)}, 400)
        elif self._job_path("library") and self._job_path("library")[1] == "save":
            try:
                self._json(_saves.start(self._job_path("library")[0], self._body(), _live_id()))
            except saves.Busy as e:
                self._json({"error": str(e)}, 409)
            except (ValueError, AttributeError) as e:   # bad JSON, not ready yet, no picture for an MP4
                self._json({"error": str(e)}, 400)
        elif self._job_path("saves") and self._job_path("saves")[1] == "cancel":
            self._json({"ok": _saves.stop(self._job_path("saves")[0])})
        elif self._job_path("player"):
            self._open_player(*self._job_path("player"))
        elif self.path in ("/cases", "/cases/source"):
            self._report()
        elif self.path == "/keep":
            self._keep()
        else:
            self._json({"error": "not found"}, 404)

    def _open_player(self, row_id, action):
        try:
            if action == "convert":
                self._json(_player.convert(row_id))
            elif action == "stream":
                self._json(_player.refind(row_id))
            elif action == "quality":
                self._json(_player.quality(row_id, self._body().get("height")))
            elif action is None:
                it = _player.open(row_id, _jobs.get(_jobs.job["id"]) if _jobs.job else None)
                running = _saves.item if _saves.item and _saves.item["state"] == "running" else None
                it["save"]["running"] = dict(running) if running else None
                self._json(it)
            else:
                self._json({"error": "not found"}, 404)
        except ValueError as e:   # gone, must be cleaned again ("again"), or not in the library
            self._json({"error": str(e)}, 409)

    def _keep(self):
        """A new keep rule from Settings. Applied now when nothing is cleaned or saved, else after that job."""
        try:
            spec = self._body()
            history.set_keep(spec.get("days"), spec.get("gb"))
        except (ValueError, TypeError, AttributeError) as e:
            return self._json({"error": str(e)}, 400)
        removed = 0
        if _idle():
            try:
                removed = history.clean_history()
            except Exception:
                pass   # tried again after the next job and at the next start
        self._json({**history.keep_rule(), "removed": removed})

    def _report(self):
        """Report a slip. Runs on this request's own thread (the server has one per request), so a slow copy or
        download never holds up the window's other calls."""
        try:
            spec = self._body()
            if self.path == "/cases/source":
                self._json(cases.pick_source(spec.get("row"), spec.get("path")))
            else:
                self._json(cases.report(spec))
        except (ValueError, AttributeError) as e:   # bad JSON, or a message for the user (times, file not found...)
            self._json({"error": str(e)}, 400)
        except Exception as e:   # a download or copy that failed (old Naqi: "Could not save: ...")
            self._json({"error": f"Could not save: {str(e).replace('ERROR: ', '')}"}, 500)

    def _wave(self, row_id):
        """The report page's sound strip: the shape of row's cleaned sound (read with ffmpeg, on this thread)."""
        try:
            self._json(_player.wave(row_id, _jobs.get(_jobs.job["id"]) if _jobs.job else None))
        except ValueError as e:   # Naqi has no cleaned sound of it (the page says why)
            self._json({"error": str(e)}, 409)
        except Exception:
            self._json({"error": "The cleaned sound could not be read. Type the times below."}, 500)

    def _muted(self, row_id):
        """The player's time bar: where row's cleaned sound was muted (read on this thread)."""
        try:
            self._json(_player.muted(row_id, _jobs.get(_jobs.job["id"]) if _jobs.job else None))
        except ValueError as e:
            self._json({"error": str(e)}, 409)
        except Exception:
            self._json({"error": "The muted parts could not be read."}, 500)

    def _media(self, parts):
        """The page's <audio> / <video> read these (through Electron, which adds the token)."""
        if len(parts) == 2 and parts[0].isdigit() and parts[1] == "sound":
            row_id = int(parts[0])
            self._send_file(_player.sound_path(row_id), hold=lambda: player.clean_edge(_jobs.job, row_id), keep_size=True)
        elif len(parts) == 3 and parts[0] == "pictures" and parts[1].isdigit() and parts[2] in ("part", "full"):
            item = _pictures.get(int(parts[1]))
            self._send_file(item and item.get(parts[2]))
        elif len(parts) == 2 and parts[0] == "stream" and parts[1].isdigit():
            self._send_stream(int(parts[1]))
        else:
            self._json({"error": "not found"}, 404)

    def _send_file(self, path, hold=lambda: None, keep_size=False):
        """A file with byte ranges. hold() -> the bytes that are final so far (None: all of it): a request past
        them waits until they are, so the browser never plays the silence of the part not clean yet. The file is
        opened for each piece only, so a cancelled cleaning or a Remove can still delete it.
        keep_size: the size first sent stays (cleaned.wav is cut to its exact length once all is clean, often a
        little shorter than the length guessed at the start, when the sound ends before the picture); the browser
        still asks for the length it was told, gets silence past the real end and reaches the end."""
        if not path or not os.path.isfile(path):
            return self._json({"error": "not found"}, 404)
        size = os.path.getsize(path)
        if keep_size:
            with _sizes_lock:
                size = _sizes[path] = max(size, _sizes.get(path, 0))
        a, b = 0, size - 1
        rng = self.headers.get("Range", "")
        if rng.startswith("bytes="):
            lo, _, hi = rng[6:].split(",")[0].strip().partition("-")
            try:
                a, b = (int(lo), min(int(hi), size - 1) if hi else size - 1) if lo else (max(0, size - int(hi)), size - 1)
            except ValueError:
                a, b = 0, size - 1
            if a >= size or a > b:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        self.send_response(206 if rng else 200)
        self.send_header("Content-Type", MEDIA_TYPES.get(os.path.splitext(path)[1].lower(), "application/octet-stream"))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(b - a + 1))
        if rng:
            self.send_header("Content-Range", f"bytes {a}-{b}/{size}")
        self.end_headers()
        pos = a
        try:
            while pos <= b:
                end = min(b + 1, pos + MEDIA_CHUNK)
                edge = hold()
                while edge is not None and edge <= pos:
                    time.sleep(0.05)   # not clean yet: the browser waits here
                    edge = hold()
                if edge is not None:
                    end = min(end, edge)
                with open(path, "rb") as f:
                    f.seek(pos)
                    data = f.read(end - pos)
                self.wfile.write(data + b"\0" * (end - pos - len(data)))   # the finished file can be a little shorter
                pos = end
        except OSError:   # the browser dropped this request (it does on every jump), or the file was deleted
            self.close_connection = True

    def _send_stream(self, row_id):
        """A link's picture, passed through from the site with the headers yt-dlp says it needs."""
        found = _player.stream_request(row_id)
        if not found:
            return self._json({"error": "no stream"}, 404)
        try:
            status, out, body = player.open_stream(*found, self.headers.get("Range"))
        except Exception as e:   # refused (often 403) or no answer: the page looks it up once more
            return self._json({"error": str(e)}, getattr(e, "code", None) or 502)
        try:
            self.send_response(status)
            for key, value in out.items():
                self.send_header(key, value)
            if "Content-Length" not in out:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            for data in body:
                self.wfile.write(data)
        except OSError:   # the page dropped this request (it does on every jump), or a later piece was refused
            self.close_connection = True
        finally:
            body.close()

    def _job_path(self, base="jobs"):
        """/<base>/<id> or /<base>/<id>/<action> -> (id, action or None); None for any other path."""
        parts = self.path.strip("/").split("/")
        if len(parts) in (2, 3) and parts[0] == base and parts[1].isdigit():
            return int(parts[1]), parts[2] if len(parts) == 3 else None
        return None

    def _body(self):
        if self._raw is None:
            raise ValueError("request too large")
        return json.loads(self._raw or b"{}")

    def _kinds(self):
        """{"paths": [...]} -> {"kinds": {path: "audio" | "video"}}: what the Home file list shows as AUDIO / VIDEO."""
        try:
            paths = self._body().get("paths") or []
            if not isinstance(paths, list) or len(paths) > 500:
                raise ValueError("paths must be a list")
            self._json({"kinds": {p: files.real_kind(p) for p in paths if isinstance(p, str) and os.path.isfile(p)}})
        except (ValueError, AttributeError) as e:
            self._json({"error": str(e)}, 400)

    def _start_picture(self):
        try:
            self._json(_pictures.start(self._body()))
        except (ValueError, AttributeError) as e:   # bad JSON, a bad description, or a file with no picture
            self._json({"error": str(e)}, 400)

    def _start_job(self):
        try:
            spec = self._body()
            if _state["state"] != "ready":
                return self._json({"error": "The engine is not ready yet."}, 503)
            self._json(_jobs.start(spec))
        except jobs.Busy as e:
            self._json({"error": str(e)}, 409)
        except (ValueError, AttributeError) as e:   # bad JSON or a bad job description
            self._json({"error": str(e)}, 400)

    def _events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        q = queue.Queue()
        q.put(("state", dict(_state)))   # a new listener first gets the current state
        if _gpu:
            q.put(("gpu", dict(_gpu)))
        with _clients_lock:
            _clients.append(q)
        try:
            while True:
                try:
                    event, data = q.get(timeout=HEARTBEAT_S)
                    self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode("utf-8"))
                except queue.Empty:
                    self.wfile.write(b": alive\n\n")
                self.wfile.flush()
        except OSError:   # the window closed the stream
            pass
        finally:
            with _clients_lock:
                _clients.remove(q)


def _exit_when_parent_goes(pid):
    """Wait for the Electron process to end (quit or crash), then stop.
    Not done by reading stdin: on Windows a waiting read on a pipe blocks other calls on it, and importing
    PyTorch then hangs."""
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(0x00100000, False, pid)   # SYNCHRONIZE: only the right to wait for it
    if handle:
        kernel32.WaitForSingleObject(handle, 0xFFFFFFFF)     # INFINITE
    os._exit(0)


def main():
    if not TOKEN:
        sys.exit("NAQI_TOKEN is not set; the engine only runs when started by the Naqi window.")
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    parent = int(os.environ.get("NAQI_PARENT_PID") or 0)
    if parent:
        threading.Thread(target=_exit_when_parent_goes, args=(parent,), daemon=True).start()
    threading.Thread(target=_start_up, daemon=True).start()
    print(json.dumps({"port": server.server_address[1]}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
