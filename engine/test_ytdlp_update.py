"""Test of yt-dlp keeping itself up to date (ROADMAP T8.1, SPEC R24). Needs the internet (PyPI and a 19 s YouTube
link). Runs in a new temporary data folder (NAQIE_DATA); the yt-dlp in this PC's Python is never changed.
PyPI's newest yt-dlp is usually the one installed here, so the test pretends Naqi's own copy is older.
Run: py -3.12 engine/test_ytdlp_update.py   (prints each check, exit code 0 when all pass)
"""
import json
import os
import shutil
import sys
import tempfile
import time
import urllib.request

TMP = tempfile.mkdtemp(prefix="naqie-ytu-")
os.environ["NAQIE_DATA"] = os.path.join(TMP, "data")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ytdlp_update as yu   # noqa: E402  (after NAQIE_DATA is set)
import downloads   # noqa: E402

SHORT = "https://www.youtube.com/watch?v=jNQXAC9IVRw"   # "Me at the zoo", 19 s
CHANGED = "ERROR: [youtube] x: Unable to extract nsig; please report this issue on https://github.com/yt-dlp/yt-dlp"
failed = 0


def check(name, ok, detail=""):
    global failed
    failed += not ok
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""))


def under_dir():
    return os.path.normcase(downloads.yt_dlp.__file__).startswith(os.path.normcase(yu.DIR))


def back_to_own():
    """Naqi's own yt-dlp again (the test deletes the copy in use, which the engine never does)."""
    import importlib
    for name in [n for n in sys.modules if n == "yt_dlp" or n.startswith("yt_dlp.")]:
        del sys.modules[name]
    if yu._info["path"] in sys.path:
        sys.path.remove(yu._info["path"])
    yu._info.update(path=None, own=own, active=own)
    downloads.yt_dlp = importlib.import_module("yt_dlp")
    downloads.DownloadCancelled = downloads.yt_dlp.utils.DownloadCancelled


def pretend_older():
    yu._info.update(own="2000.01.01", active="2000.01.01", asked=0.0)


try:
    own = yu._own_version()
    latest = json.load(urllib.request.urlopen(yu.PYPI, timeout=20))["info"]["version"]
    check("own yt-dlp is used while nothing is downloaded", yu.version() == own and not under_dir(),
          f"own {own}, PyPI {latest}")

    # A newer one: the daily check downloads it and, nothing running, uses it at once (no restart)
    pretend_older()
    yu.daily(idle=lambda: False)
    check("daily check downloads it, but waits while a job runs",
          os.path.isdir(os.path.join(yu.DIR, latest)) and yu.version() == "2000.01.01" and not under_dir())
    check("only yt_dlp files unpacked, no work files left",
          sorted(os.listdir(yu.DIR)) == sorted([latest, "state.json"])
          and os.listdir(os.path.join(yu.DIR, latest)) == ["yt_dlp"], str(os.listdir(yu.DIR)))
    checked = json.load(open(yu.STATE))["checked"]
    check("check time kept", time.time() - checked < 60)
    t = time.perf_counter()
    yu.daily(idle=lambda: True)
    check("second daily check the same day asks nothing", time.perf_counter() - t < 0.5 and yu.version() == "2000.01.01")
    check("a site-changed failure then uses the downloaded copy", yu.fresh() and yu.version() == latest and under_dir(),
          downloads.yt_dlp.__file__)
    check("downloads.py uses it too", downloads.yt_dlp.version.__version__ == latest
          and downloads.DownloadCancelled is sys.modules["yt_dlp.utils"].DownloadCancelled)
    url, headers, at, _ = downloads.video_stream(SHORT)
    check("a link is read with the swapped-in yt-dlp", bool(url and url.startswith("http")))

    # A new engine start picks the downloaded copy before yt_dlp is imported
    import subprocess
    code = ("import sys; sys.path.insert(0, %r); import ytdlp_update as u; u._own_version = lambda: '2000.01.01'; "
            "u.use_newest(); import yt_dlp; print(yt_dlp.__file__)" % os.path.dirname(os.path.abspath(__file__)))
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                         env={**os.environ, "NAQIE_DATA": os.environ["NAQIE_DATA"]}).stdout.strip()
    check("next start imports the downloaded copy", os.path.normcase(out).startswith(os.path.normcase(yu.DIR)), out)

    # Nothing newer on PyPI: a failure does not download again, and asks PyPI at most every 10 min
    check("nothing newer: no second download, no retry", not yu.fresh())

    # A wrong checksum is refused and leaves nothing
    back_to_own()
    shutil.rmtree(os.path.join(yu.DIR, latest))
    pretend_older()
    real = urllib.request.urlopen

    class Meta:
        def __init__(self, data):
            self.data = data

        def __enter__(self):
            return self

        def __exit__(self, *a):
            pass

        def read(self, *a):
            return self.data

    def bad_digest(url, timeout=None):
        if url == yu.PYPI:
            meta = json.load(real(url, timeout=timeout))
            for u in meta["urls"]:
                u["digests"]["sha256"] = "0" * 64
            return Meta(json.dumps(meta).encode())
        return real(url, timeout=timeout)

    yu.urllib.request.urlopen = bad_digest
    try:
        refused = not yu.fresh()
    finally:
        yu.urllib.request.urlopen = real
    check("wrong checksum refused, nothing kept", refused and sorted(os.listdir(yu.DIR)) == ["state.json"],
          str(os.listdir(yu.DIR)))

    # A copy that does not import goes back to the one before and is never used again
    yu._info.update(own=own, active=own)
    broken = os.path.join(yu.DIR, "2999.01.01", "yt_dlp")
    os.makedirs(broken)
    with open(os.path.join(broken, "__init__.py"), "w") as f:
        f.write("raise ImportError('broken on purpose')\n")
    yu._info["asked"] = time.time()
    check("broken copy not used", not yu.fresh() and downloads.yt_dlp.version.__version__ == own and not under_dir())
    check("broken copy marked bad", "2999.01.01" in json.load(open(yu.STATE)).get("bad", []))
    url, headers, at, _ = downloads.video_stream(SHORT)
    check("links still work after the broken copy", bool(url))

    # The retry rule: only a site-changed failure, only once, only when a newer yt-dlp is in use
    calls, asked = [], []
    real_fresh = downloads.ytdlp_update.fresh

    def fake(fail):
        @downloads.updates
        def run():
            calls.append(1)
            if len(calls) <= fail:
                raise RuntimeError(CHANGED)
            return "ok"
        return run

    try:
        downloads.ytdlp_update.fresh = lambda: asked.append(1) or True
        check("site changed: updated and tried again", fake(1)() == "ok" and len(calls) == 2 and len(asked) == 1)
        calls.clear()
        asked.clear()
        try:
            fake(5)()
            check("second failure is the error", False)
        except RuntimeError:
            check("second failure is the error (tried only twice)", len(calls) == 2)
        calls.clear()
        asked.clear()
        downloads.ytdlp_update.fresh = lambda: asked.append(1) or False
        try:
            fake(1)()
        except RuntimeError:
            pass
        check("no newer yt-dlp: the error at once", len(calls) == 1 and len(asked) == 1)

        @downloads.updates
        def gone():
            calls.append(1)
            raise RuntimeError("ERROR: [youtube] aaaaaaaaaaa: Video unavailable")
        calls.clear()
        asked.clear()
        try:
            gone()
        except RuntimeError:
            pass
        check("other errors are not retried", len(calls) == 1 and not asked)
        check("plain words unchanged", "site has changed" in downloads.link_error(CHANGED))

        import jobs
        tries = []

        def once(*a):
            tries.append(1)
            return (("error", downloads.link_error(CHANGED)), CHANGED) if len(tries) == 1 else (("done", "x.mp4"), "")
        jobs._clean_link_once = once
        downloads.ytdlp_update.fresh = lambda: True
        check("Home link job tried again after an update", jobs._clean_link({}, "", None, None, lambda: False)
              == ("done", "x.mp4") and len(tries) == 2)
        tries.clear()
        check("cancelled link job is not tried again", jobs._clean_link({}, "", None, None, lambda: True)[0] == "error"
              and len(tries) == 1)
    finally:
        downloads.ytdlp_update.fresh = real_fresh
finally:
    shutil.rmtree(TMP, ignore_errors=True)

print("ALL PASS" if not failed else f"{failed} FAILED")
sys.exit(1 if failed else 0)
