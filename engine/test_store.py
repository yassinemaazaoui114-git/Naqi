"""Test of the engine's history, ratings, slip cases and file helpers (ROADMAP T0.3).
Runs in a new temporary data folder (NAQIE_DATA), so the real NaqiE-data is never touched.
Run: py -3.12 engine/test_store.py   (prints each check, exit code 0 when all pass)
"""
import datetime
import os
import subprocess
import sys
import tempfile

TMP = tempfile.mkdtemp(prefix="naqie-test-")
os.environ["NAQIE_DATA"] = os.path.join(TMP, "data")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cases     # noqa: E402  (after NAQIE_DATA is set)
import files     # noqa: E402
import history   # noqa: E402

failed = 0


def check(name, ok):
    global failed
    failed += not ok
    print(("PASS " if ok else "FAIL ") + name)


def make_sound(path, seconds):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
                    path], check=True, capture_output=True)


def age(row_id, days):
    """Makes a row look `days` old."""
    when = (datetime.datetime.now() - datetime.timedelta(days=days)).isoformat(timespec="seconds")
    history._history("UPDATE files SET added = ? WHERE id = ?", (when, row_id))


def cached_row(title, size, days=0):
    """A "Clean and play" row with a cache of `size` bytes in its own history folder."""
    folder = history.new_history_folder()
    result = os.path.join(folder, history.CACHE_NAME)
    with open(result, "wb") as f:
        f.write(b"\0" * size)
    row_id = history.add_history("https://example.com/" + title, title, None, result)
    age(row_id, days)
    return row_id, folder


check("data folder is the test folder", files.DATA_DIR == os.environ["NAQIE_DATA"])

# ---- file helpers
check("guess_kind audio", files.guess_kind(r"C:\a\Song.MP3") == "audio")
check("guess_kind video", files.guess_kind(r"C:\a\clip.mkv") == "video")
check("is_link", files.is_link("https://youtu.be/x") and not files.is_link(r"C:\a.mp4"))
check("file_name", files.file_name('A: "b"/c?') == "A_ _b__c_" and files.file_name("") == "Naqi"
      and len(files.file_name("x" * 200)) == files.TITLE_MAX)
os.makedirs(files.DATA_DIR)
taken = os.path.join(files.DATA_DIR, "out.mp3")
open(taken, "w").close()
check("unique_path", files.unique_path(taken) == os.path.join(files.DATA_DIR, "out (2).mp3")
      and files.unique_path(os.path.join(files.DATA_DIR, "free.mp3")).endswith("free.mp3"))

# ---- history rows
own = os.path.join(TMP, "own.wav")
make_sound(own, 3)
a = history.add_history(own, "Own file", None, own)
b = history.add_history("https://example.com/v", "Link", None, os.path.join(TMP, "link.mp3"))
rows = history.recent_history()
check("add + read rows (newest first)", [r["id"] for r in rows] == [b, a] and rows[1]["title"] == "Own file")
check("find_history", history.find_history(own)["id"] == a and history.find_history(os.path.join(TMP, "no")) is None)
history.set_rating(a, "good")
history.mark_reported(a)
r = history.find_history(own)
check("set_rating + mark_reported", r["rating"] == "good" and r["reported"] == 1)
history.delete_row(b)
check("delete_row", [r["id"] for r in history.recent_history()] == [a])

# ---- "Clean and play" cache states
c, folder = cached_row("played", 100)
r = history.recent_history(1)[0]
check("cache row: is_cache, has_cache, plays the cache", history.is_cache(r["result"]) and history.has_cache(r)
      and history.play_path(r) == r["result"] and history.history_folder(r) == folder)
mp4 = os.path.join(TMP, "saved.mp4")
open(mp4, "w").close()
history.add_saved(c, os.path.join(TMP, "gone.mp3"))
history.add_saved(c, mp4)
r = history.recent_history(1)[0]
check("add_saved keeps both, saved_files only existing", r["saved"].count("\n") == 1 and history.saved_files(r) == [mp4])
history.restart_row(c, None, r["result"])
r = history.recent_history(1)[0]
check("restart_row: not ready, cleaned again on Play, else plays the saved MP4",
      not history.has_cache(r) and not history.needs_cleaning(r) and history.play_path(r) == mp4)
history.mark_ready(c)
check("mark_ready", history.has_cache(history.recent_history(1)[0]))

# ---- slip cases
n = cases.save_case(own, "0:01", "2.5", "music", "  a   note ")
rows = cases.read_cases()
check("save_case: CSV row", n == 1 and rows[0]["source"] == os.path.normpath(own) and rows[0]["start"] == "0:01"
      and rows[0]["end"] == "2.5" and rows[0]["expect"] == "music" and rows[0]["note"] == "a note"
      and rows[0]["added"] == datetime.date.today().isoformat())
copy = os.path.join(cases.CASES_DIR, cases.case_key(os.path.normpath(own)), "own.wav")
check("save_case: copy of the sound in cases", os.path.isfile(copy))
with open(cases.CASES_CSV, "rb") as f:
    check("slip_cases.csv is UTF-8 without BOM", not f.read(3).startswith(b"\xef\xbb\xbf"))
for name, args, want in [("duplicate", (own, "1", "2.5", "music"), "already saved"),
                         ("bad kind", (own, "1", "2", "noise"), "must be one of"),
                         ("bad time", (own, "x", "2", "music"), "Write the times"),
                         ("to before from", (own, "2", "1", "music"), "must be after"),
                         ("past the end", (own, "1", "9", "speech"), "only 0:03"),
                         ("missing file", (os.path.join(TMP, "no.wav"), "1", "2", "music"), "File not found")]:
    try:
        cases.save_case(*args)
        check("save_case refuses " + name, False)
    except ValueError as e:
        check("save_case refuses " + name, want in str(e))
check("refused cases add no row", len(cases.read_cases()) == 1)

# ---- clean-up rule: 14 days, then 5 GB (newest kept), orphan folders after a day, cases never touched
for r in history.recent_history():
    history.delete_row(r["id"])
fresh, fresh_dir = cached_row("fresh", 1000)
old, old_dir = cached_row("old", 1000, days=15)
edge, edge_dir = cached_row("edge", 1000, days=13)
orphan_old = history.new_history_folder()
open(os.path.join(orphan_old, "x"), "w").close()
os.utime(orphan_old, (0, datetime.datetime.now().timestamp() - 2 * 86400))
orphan_new = history.new_history_folder()
gone = history.clean_history()
by_id = {r["id"]: r for r in history.recent_history()}
check("14 days: the 15-day-old cache is deleted, 13-day-old stays", gone == 1 and not os.path.exists(old_dir)
      and os.path.exists(edge_dir) and os.path.exists(fresh_dir))
check("rows stay after clean-up, the old one needs cleaning again", len(by_id) == 3
      and history.needs_cleaning(by_id[old]) and not history.needs_cleaning(by_id[fresh]))
check("orphan folder: deleted after a day, kept when new", not os.path.exists(orphan_old)
      and os.path.exists(orphan_new))
history.HISTORY_MAX_BYTES = 1500   # stands for 5 GB: room for one of the two 1000-byte caches
history.clean_history()   # the count also includes rows already cleaned up (same as old Naqi)
check("size limit: the oldest goes, the newest stays", os.path.exists(fresh_dir)
      and not os.path.exists(edge_dir))
history.HISTORY_MAX_BYTES = 5 * 10**9
check("clean-up never touches cases", os.path.isfile(copy) and len(cases.read_cases()) == 1)
check("real limits are 14 days / 5 GB", history.HISTORY_DAYS == 14 and history.HISTORY_MAX_BYTES == 5 * 10**9)

print(f"\n{'ALL PASSED' if not failed else f'{failed} FAILED'}  (test data in {TMP})")
sys.exit(1 if failed else 0)
