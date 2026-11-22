"""Fills a test data folder (NAQIE_DATA, never the real one) with library items in every state, for the window's
library self-test (NAQI_SELFTEST=library, ROADMAP T3.1). Prints {"saved": <saved MP4>, "own": <own file>} as JSON.
Run: NAQIE_DATA=<test folder> py -3.12 engine/seed_library.py <folder for the "saved" and "own" files>
"""
import datetime
import json
import os
import shutil
import sys

if not os.environ.get("NAQIE_DATA"):
    sys.exit("NAQIE_DATA must point to a test data folder")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import history  # noqa: E402

out = os.path.abspath(sys.argv[1])
shutil.rmtree(os.environ["NAQIE_DATA"], ignore_errors=True)
shutil.rmtree(out, ignore_errors=True)


def touch(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"\0" * 1000)
    return path


def at(row, days):
    when = (datetime.datetime.now() - datetime.timedelta(days=days)).isoformat(timespec="seconds")
    history._history("UPDATE files SET added = ? WHERE id = ?", (when, row))


def played(source, title, days=0, keep=True):
    folder = history.new_history_folder()
    cache = os.path.join(folder, history.CACHE_NAME)
    if keep:
        touch(cache)
    row = history.add_history(source, title, None, cache)
    at(row, days)
    if not keep:
        shutil.rmtree(folder)
    return row


own = touch(os.path.join(out, "mine", "Friday talk.wav"))
saved = touch(os.path.join(out, "Naqi Downloads", "Cooking with three spices.mp4"))
moved = os.path.join(out, "Naqi Downloads", "Morning reminder.mp3")
# Oldest first, so the newest ends on top
played(own, "Friday talk.wav", days=20, keep=False)                                     # again (cache tidied)
at(history.add_history(own, "Morning reminder.wav", None, moved), 9)                    # gone (file moved)
at(history.add_history("https://www.youtube.com/watch?v=abc", "Cooking with three spices", None, saved), 1)
played("https://www.tiktok.com/@a/video/1", "رحلة إلى الجبال الخضراء", days=0)
played(own, "Evening lecture, part 3 (full recording from the hall with questions and answers).wav")
played("https://www.youtube.com/watch?v=jNQXAC9IVRw", "How the desert keeps its water")
print(json.dumps({"saved": saved, "own": own}))
