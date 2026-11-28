"""History + ratings (old Naqi SPEC R13, R14d), copied from old Naqi app.py with no Qt code (ROADMAP T0.3).
One row per cleaned file in DATA_DIR\\history.db; links also keep their original sound, and "Clean and play" keeps
its cleaned-sound cache, in a folder of DATA_DIR\\history for 2 weeks (at most 5 GB in all).
"""
import datetime
import glob
import os
import shutil
import sqlite3
import subprocess
import threading

from files import DATA_DIR, NOWIN

HISTORY_DB = os.path.join(DATA_DIR, "history.db")
HISTORY_DIR = os.path.join(DATA_DIR, "history")
HISTORY_DAYS = 14                 # kept sounds older than this are deleted...
HISTORY_MAX_BYTES = 5 * 10**9     # ...and the oldest ones too while all kept sounds together are bigger than this
KEEP_DAYS = (7, 14, 30, 90)       # what the Settings page offers (T11.2); 2 weeks / 5 GB stays the default
KEEP_GB = (2, 5, 10, 20)
RATINGS = [("bad", "Bad"), ("good", "Good"), ("perfect", "Perfect")]
LIBRARY_MAX = 500                 # newest cleaned files shown in the library (SPEC R14)
CACHE_NAME = "cleaned.wav"        # "Clean and play": the cleaned sound, in the item's history folder (SPEC R14d)

_history_lock = threading.Lock()   # jobs and requests from the window both write

# AUTOINCREMENT: a row's id is never given again. Without it SQLite reuses the id of the newest row once it is deleted
# (a cancelled Clean and play, a Remove), and whatever the engine or the window still held for that id (a link's
# stream, the open player) went to the next item: a cancelled YouTube video's picture showed over the next link.
COLUMNS = ("id INTEGER PRIMARY KEY AUTOINCREMENT, added TEXT, source TEXT, title TEXT, sound TEXT, result TEXT, "
           "rating TEXT DEFAULT '', reported INTEGER DEFAULT 0, ready INTEGER DEFAULT 1, saved TEXT DEFAULT '', "
           "at REAL DEFAULT 0, length REAL DEFAULT 0, watched TEXT DEFAULT '', shot TEXT DEFAULT ''")
_ids_checked = False


def _never_reuse_ids(con):
    """history.db made by old Naqi or before 2026-11-26 has ids that can be reused: the table is copied once into
    one with AUTOINCREMENT, same ids and rows (inside the caller's transaction: all or nothing)."""
    global _ids_checked
    if _ids_checked:
        return
    sql = con.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'files'").fetchone()[0]
    if "AUTOINCREMENT" not in sql.upper():
        names = ", ".join(c.split()[0] for c in COLUMNS.split(", ") if c.split()[0] in
                          [r[1] for r in con.execute("PRAGMA table_info(files)")])
        if not con.in_transaction:
            con.execute("BEGIN")   # Python's sqlite3 opens none before CREATE: the copy must be one step
        con.execute("DROP TABLE IF EXISTS files_new")
        con.execute(f"CREATE TABLE files_new ({COLUMNS})")
        con.execute(f"INSERT INTO files_new ({names}) SELECT {names} FROM files")
        con.execute("DROP TABLE files")
        con.execute("ALTER TABLE files_new RENAME TO files")
    _ids_checked = True


def _history(sql, args=()):
    """Runs one statement on history.db (made on first use). Returns (rows as dicts, id of a new row).
    ready = 0 while a "Clean and play" cache is still being written (or was left unfinished); saved = the files a
    played item was saved as (one path per line, SPEC R14)."""
    with _history_lock:
        os.makedirs(DATA_DIR, exist_ok=True)
        con = sqlite3.connect(HISTORY_DB, timeout=10)
        try:
            con.row_factory = sqlite3.Row
            with con:   # commits
                con.execute(f"CREATE TABLE IF NOT EXISTS files ({COLUMNS})")
                have = [c[1] for c in con.execute("PRAGMA table_info(files)")]
                if "ready" not in have:   # made by v5.2 or older
                    con.execute("ALTER TABLE files ADD COLUMN ready INTEGER DEFAULT 1")
                if "saved" not in have:   # made by v5.4 or older
                    con.execute("ALTER TABLE files ADD COLUMN saved TEXT DEFAULT ''")
                if "at" not in have:   # made before T13.4 (resume where you stopped)
                    for col in ("at REAL DEFAULT 0", "length REAL DEFAULT 0", "watched TEXT DEFAULT ''", "shot TEXT DEFAULT ''"):
                        con.execute(f"ALTER TABLE files ADD COLUMN {col}")
                _never_reuse_ids(con)
                cur = con.execute(sql, args)
                return [dict(r) for r in cur.fetchall()], cur.lastrowid
        finally:
            con.close()


def new_history_folder():
    folder = os.path.join(HISTORY_DIR, datetime.datetime.now().strftime("%Y%m%d-%H%M%S-") + os.urandom(3).hex())
    os.makedirs(folder)
    return folder


def history_folder(r):
    """The row's own folder in the history (kept original sound and/or cleaned-sound cache), or None."""
    for path in (r.get("sound"), r.get("result")):
        if path and os.path.normcase(os.path.dirname(os.path.dirname(path))) == os.path.normcase(HISTORY_DIR):
            return os.path.dirname(path)
    return None


def is_cache(path):
    """Is this cleaned result a "Clean and play" cache (played, not saved as a file)?"""
    return bool(path) and history_folder({"result": path}) is not None


def has_cache(r):
    """Is the played item's cleaned sound there and finished (it plays from it and can be saved)?"""
    return is_cache(r["result"]) and bool(r.get("ready", 1)) and os.path.isfile(r["result"])


def saved_files(r):
    """The files a played item was saved as that are still there, oldest first (SPEC R14)."""
    return [p for p in (r.get("saved") or "").split("\n") if p and os.path.isfile(p)]


def needs_cleaning(r):
    """A played item whose cleaned sound was deleted or never finished and that was not saved either: it is cleaned
    again on Play."""
    return is_cache(r["result"]) and not has_cache(r) and not saved_files(r)


def play_path(r):
    """What the player plays for a row: the cleaned-sound cache while it is there, else a saved file of it (an MP4
    first: it has the picture), else its cleaned file."""
    saved = saved_files(r)
    if is_cache(r["result"]) and not has_cache(r) and saved:
        return next((p for p in saved if p.lower().endswith(".mp4")), saved[0])
    return r["result"]


def keep_sound(path):
    """Copy of a downloaded file's original sound, taken before it is cleaned in place (MP4: only the sound track,
    copied as it is, not re-encoded). Returns its path, or None when it could not be kept (the job goes on)."""
    folder = None
    try:
        folder = new_history_folder()
        if path.lower().endswith(".mp3"):
            dst = os.path.join(folder, "original.mp3")
            shutil.copyfile(path, dst)
        else:
            dst = os.path.join(folder, "original.mka")   # Matroska takes any sound format as it is
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-map", "0:a:0", "-vn", "-c:a", "copy", dst],
                           capture_output=True, stdin=subprocess.DEVNULL, creationflags=NOWIN, check=True)
        return dst
    except Exception:
        if folder:
            shutil.rmtree(folder, ignore_errors=True)
        return None


def drop_sound(path):
    """Deletes the history folder that holds `path` (a kept sound or a cache; never anything outside the history)."""
    folder = path and history_folder({"sound": path})
    if folder:
        shutil.rmtree(folder, ignore_errors=True)


def add_history(source, title, sound, result, ready=1):
    """source: the video link or the own file's path; sound: kept original sound (links only). Returns the id."""
    return _history("INSERT INTO files (added, source, title, sound, result, ready) VALUES (?, ?, ?, ?, ?, ?)",
                    (datetime.datetime.now().isoformat(timespec="seconds"), source, title, sound,
                     os.path.normpath(result), ready))[1]


def restart_row(row_id, sound, result):
    """A played item is cleaned again: new files, ready = 0, and it counts as new (2-week clean-up)."""
    _history("UPDATE files SET added = ?, sound = ?, result = ?, ready = 0 WHERE id = ?",
             (datetime.datetime.now().isoformat(timespec="seconds"), sound, os.path.normpath(result), row_id))


def mark_ready(row_id):
    _history("UPDATE files SET ready = 1 WHERE id = ?", (row_id,))


def delete_row(row_id):
    _history("DELETE FROM files WHERE id = ?", (row_id,))


def recent_history(limit=30):
    return _history("SELECT * FROM files ORDER BY added DESC, id DESC LIMIT ?", (limit,))[0]


def get_row(row_id):
    rows = _history("SELECT * FROM files WHERE id = ?", (row_id,))[0]
    return rows[0] if rows else None


def find_history(result):
    """The newest history row whose cleaned file is `result`, or None."""
    rows = _history("SELECT * FROM files WHERE result = ? COLLATE NOCASE ORDER BY id DESC LIMIT 1",
                    (os.path.normpath(os.path.abspath(result)),))[0]
    return rows[0] if rows else None


def add_saved(row_id, path):
    _history("UPDATE files SET saved = CASE WHEN COALESCE(saved, '') = '' THEN ? ELSE saved || char(10) || ? END "
             "WHERE id = ?", (os.path.normpath(path),) * 2 + (row_id,))


def set_rating(row_id, rating):
    _history("UPDATE files SET rating = ? WHERE id = ?", (rating, row_id))


# Resume where you stopped (ROADMAP T13.4, SPEC R48): at = the second to open at again (0 = from the start)
RESUME_MIN_LENGTH_S = 60    # shorter items always open from the start
RESUME_MIN_AT_S = 10        # stopped in the first seconds: not started really, it opens from the start
FINISHED_SHARE = 0.9        # past 90%...
FINISHED_LEFT_S = 60        # ...or in the last 60 s it counts as finished (Yassine, 2026-11-27)


def resume_at(at, length):
    """Where an item stopped at `at` of `length` seconds opens again: `at`, or 0 when it is too short, barely
    started or finished."""
    at, length = float(at or 0), float(length or 0)
    if length < RESUME_MIN_LENGTH_S or at < RESUME_MIN_AT_S or at >= FINISHED_SHARE * length or length - at <= FINISHED_LEFT_S:
        return 0.0
    return round(at, 2)


def set_position(row_id, at, length, shot=""):
    """Remembers where a played item stopped (and a small picture of that moment, a data: URL). Returns the
    second it will open at."""
    at = resume_at(at, length)
    shot = shot if at and isinstance(shot, str) and shot.startswith("data:image/jpeg;base64,") and len(shot) < 60000 else ""
    _history("UPDATE files SET at = ?, length = ?, watched = ?, shot = ? WHERE id = ?",
             (at, float(length or 0), datetime.datetime.now().isoformat(timespec="seconds"), shot, row_id))
    return at


def mark_reported(row_id):
    _history("UPDATE files SET reported = 1 WHERE id = ?", (row_id,))


def set_keep(days, gb):
    """The keep rule chosen in Settings (SPEC R43). Values not offered there are refused."""
    global HISTORY_DAYS, HISTORY_MAX_BYTES
    days, gb = int(days), int(gb)
    if days not in KEEP_DAYS or gb not in KEEP_GB:
        raise ValueError(f"Keep for {KEEP_DAYS} days and at most {KEEP_GB} GB")
    HISTORY_DAYS, HISTORY_MAX_BYTES = days, gb * 10**9


def keep_rule():
    """The keep rule in use and how much the kept sounds take now (bytes)."""
    used = sum(os.path.getsize(f) for f in glob.glob(os.path.join(HISTORY_DIR, "*", "*")) if os.path.isfile(f))
    return {"days": HISTORY_DAYS, "gb": HISTORY_MAX_BYTES // 10**9, "used": used}


try:   # the window passes the remembered choice when it starts the engine
    set_keep(os.environ.get("NAQI_KEEP_DAYS") or HISTORY_DAYS, os.environ.get("NAQI_KEEP_GB") or HISTORY_MAX_BYTES // 10**9)
except ValueError:
    pass   # not one of the offered values: the default stays


def clean_history():
    """Deletes kept sounds and "Clean and play" caches (SPEC R14d, same rule) older than HISTORY_DAYS, then the
    oldest ones until all together are under HISTORY_MAX_BYTES. Rows stay (they are tiny), their sound is marked as
    gone; a played item is cleaned again when it is played again. Slip cases (DATA_DIR\\cases) are never touched.
    Returns how many history folders were deleted."""
    if not os.path.exists(HISTORY_DB):
        return 0
    old = (datetime.datetime.now() - datetime.timedelta(days=HISTORY_DAYS)).isoformat(timespec="seconds")
    rows = [r for r in _history("SELECT id, added, sound, result FROM files ORDER BY added DESC, id DESC")[0]
            if history_folder(r)]
    total, full, gone = 0, False, []
    for r in rows:   # newest first: the newest sounds are the ones that stay
        size = sum(os.path.getsize(f) for f in glob.glob(os.path.join(history_folder(r), "*")) if os.path.isfile(f))
        full = full or total + size > HISTORY_MAX_BYTES
        if full or not size or r["added"] < old:
            gone.append(r)
        else:
            total += size
    for r in gone:
        drop_sound(os.path.join(history_folder(r), CACHE_NAME))
        _history("UPDATE files SET sound = NULL WHERE id = ?", (r["id"],))
    # Folders no row points to (the app was closed during a job), once they are a day old
    known = {os.path.normcase(history_folder(r)) for r in rows if r not in gone}
    for folder in glob.glob(os.path.join(HISTORY_DIR, "*")):
        if os.path.normcase(folder) not in known and \
                datetime.datetime.now().timestamp() - os.path.getmtime(folder) > 86400:
            shutil.rmtree(folder, ignore_errors=True)
    return len(gone)
