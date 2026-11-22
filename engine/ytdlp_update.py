"""yt-dlp keeps itself up to date (ROADMAP T8.1, SPEC R24). Sites change how they serve their videos now and then,
and only a newer yt-dlp can read them again. The yt-dlp that comes with Naqi (the Python one here, frozen inside the
installed app later) is never changed: a newer copy is downloaded from PyPI (the one pure-Python wheel, checked
against the SHA-256 PyPI lists for it) into `<data folder>\\yt-dlp\\<version>` and put first on the import path.
- use_newest(): before yt_dlp is first imported, the newest good copy there wins if it is newer than Naqi's own.
- daily(idle): once a day when the engine starts, look for a newer one; it is used at once if nothing is running
  (idle()), else from the next time it is needed after a failure, or the next start.
- fresh(): a link failed because the site changed (downloads.site_changed): use a newer copy already downloaded, or
  look for one now (at most once every RECHECK_S). True = a newer yt-dlp is now in use, so the link is tried again.
A copy that does not import goes back to the one before and is never used again. Network trouble is silent."""
import hashlib
import importlib
import importlib.util
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile

import files

DIR = os.path.join(files.DATA_DIR, "yt-dlp")
STATE = os.path.join(DIR, "state.json")
PYPI = "https://pypi.org/pypi/yt-dlp/json"
DAILY_S = 24 * 3600     # look for a newer yt-dlp once a day...
RECHECK_S = 10 * 60     # ...and after a failure at most this often (several failing links ask PyPI once)
TIMEOUT_S = 20

_lock = threading.RLock()
_info = {"own": None, "active": None, "path": None, "asked": 0.0}   # own = the yt-dlp that comes with Naqi


def _ver(text):
    """'2026.10.26' or '2026.10.26.1' -> a tuple that compares in order."""
    return tuple(int(n) for n in re.findall(r"\d+", text or "0"))


def _read_state():
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _write_state(**change):
    state = {**_read_state(), **change}
    os.makedirs(DIR, exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.replace(tmp, STATE)


def _own_version():
    """Version of the yt-dlp that comes with Naqi, read from its files without importing it."""
    spec = importlib.util.find_spec("yt_dlp")
    if not spec or not spec.origin:
        return None
    try:
        with open(os.path.join(os.path.dirname(spec.origin), "version.py"), encoding="utf-8") as f:
            m = re.search(r"__version__\s*=\s*['\"]([^'\"]+)", f.read())
        return m.group(1) if m else None
    except OSError:
        return None


def _downloaded():
    """The newest good downloaded copy: (version, folder), or (None, None)."""
    bad = set(_read_state().get("bad", []))
    try:
        names = [n for n in os.listdir(DIR) if re.fullmatch(r"[\d.]+", n) and n not in bad
                 and os.path.isfile(os.path.join(DIR, n, "yt_dlp", "__init__.py"))]
    except OSError:
        return None, None
    if not names:
        return None, None
    best = max(names, key=_ver)
    return best, os.path.join(DIR, best)


def use_newest():
    """Called before yt_dlp is first imported: the newest good downloaded copy goes first on the import path if it
    is newer than Naqi's own. Safe to call more than once."""
    with _lock:
        if _info["own"] is not None or "yt_dlp" in sys.modules:
            return
        _info["own"] = _info["active"] = _own_version() or "0"
        version, folder = _downloaded()
        if version and _ver(version) > _ver(_info["own"]):
            sys.path.insert(0, folder)
            _info.update(active=version, path=folder)


def version():
    """The yt-dlp version in use now."""
    use_newest()
    return _info["active"]


def _check():
    """Download a newer yt-dlp than the newest one there is, if PyPI has one. Returns its version or None."""
    _info["asked"] = time.time()
    with urllib.request.urlopen(PYPI, timeout=TIMEOUT_S) as r:
        meta = json.load(r)
    latest = meta["info"]["version"]
    have, _ = _downloaded()
    if _ver(latest) <= max(_ver(_info["own"]), _ver(have or "0")) or latest in _read_state().get("bad", []):
        return None
    wheel = next(u for u in meta["urls"] if u["packagetype"] == "bdist_wheel" and u["filename"].endswith(
        "-py3-none-any.whl"))
    os.makedirs(DIR, exist_ok=True)
    work = tempfile.mkdtemp(prefix="new-", dir=DIR)
    try:
        path = os.path.join(work, wheel["filename"])
        with urllib.request.urlopen(wheel["url"], timeout=TIMEOUT_S) as r, open(path, "wb") as f:
            shutil.copyfileobj(r, f)
        with open(path, "rb") as f:
            if hashlib.sha256(f.read()).hexdigest() != wheel["digests"]["sha256"]:
                raise ValueError("the downloaded yt-dlp does not match PyPI's checksum")
        unpacked = os.path.join(work, "files")
        with zipfile.ZipFile(path) as z:
            z.extractall(unpacked, [n for n in z.namelist() if n.startswith("yt_dlp/")])
        os.replace(unpacked, os.path.join(DIR, latest))
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return latest


def _activate():
    """Use the newest downloaded copy now, in place of the yt-dlp loaded so far. False if there is none newer or
    it does not import (then the one before stays and that copy is marked bad)."""
    version, folder = _downloaded()
    if not version or _ver(version) <= _ver(_info["active"]):
        return False
    before = _info["path"]

    def load(path):
        for name in [n for n in sys.modules if n == "yt_dlp" or n.startswith("yt_dlp.")]:
            del sys.modules[name]
        if _info["path"] in sys.path:
            sys.path.remove(_info["path"])
        if path:
            sys.path.insert(0, path)
        _info["path"] = path
        importlib.invalidate_caches()
        module = importlib.import_module("yt_dlp")
        importlib.import_module("yt_dlp.postprocessor")
        downloads = sys.modules.get("downloads")
        if downloads:   # downloads.py holds yt_dlp at its top
            downloads.yt_dlp = module
            downloads.DownloadCancelled = module.utils.DownloadCancelled
        return module

    try:
        module = load(folder)
        if module.version.__version__ != version:
            raise ImportError(f"found {module.version.__version__}, not {version}")
    except Exception:
        _write_state(bad=sorted(set(_read_state().get("bad", [])) | {version}))
        load(before)
        return False
    _info["active"] = version
    for name in os.listdir(DIR):   # older downloaded copies are not needed any more
        if name != version and re.fullmatch(r"[\d.]+", name):
            shutil.rmtree(os.path.join(DIR, name), ignore_errors=True)
    return True


def fresh():
    """A link failed because the site changed. True when a newer yt-dlp is now in use (try the link again)."""
    use_newest()
    with _lock:
        if _activate():
            return True
        if time.time() - _info["asked"] < RECHECK_S:
            return False
        try:
            if not _check():
                return False
        except Exception:
            return False
        return _activate()


def daily(idle=lambda: True):
    """Once a day (at engine start): look for a newer yt-dlp and use it at once if nothing is running."""
    use_newest()
    with _lock:
        if time.time() - _read_state().get("checked", 0) < DAILY_S:
            return
        try:
            _check()
            _write_state(checked=time.time())
        except Exception:
            return
        if idle():
            _activate()
