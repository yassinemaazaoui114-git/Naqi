"""Test of the library items (ROADMAP T3.1): states, kinds, "Show in folder", the 2 weeks / 5 GB clean-up seen from
the library, and Remove (only Naqi's own history folder goes; saved and own files stay).
Runs in a new temporary data folder (NAQIE_DATA), so the real NaqiE-data is never touched.
Run: py -3.12 engine/test_library.py   (prints each check, exit code 0 when all pass)
"""
import datetime
import os
import sys
import tempfile

TMP = tempfile.mkdtemp(prefix="naqie-lib-")
os.environ["NAQIE_DATA"] = os.path.join(TMP, "data")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import history   # noqa: E402  (after NAQIE_DATA is set)
import library   # noqa: E402

failed = 0


def check(name, ok, detail=""):
    global failed
    failed += not ok
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""))


def touch(path, size=1000):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"\0" * size)
    return path


def played(source, title, days_old=0):
    """A "Clean and play" item: kept sound (links) + cleaned.wav in its history folder."""
    folder = history.new_history_folder()
    sound = touch(os.path.join(folder, "original.m4a")) if source.startswith("http") else None
    cache = touch(os.path.join(folder, history.CACHE_NAME))
    row = history.add_history(source, title, sound, cache)
    if days_old:
        old = (datetime.datetime.now() - datetime.timedelta(days=days_old)).isoformat(timespec="seconds")
        history._history("UPDATE files SET added = ? WHERE id = ?", (old, row))
    return row, folder


def by_id(row_id):
    return next((i for i in library.items() if i["id"] == row_id), None)


saved_dir = os.path.join(TMP, "Naqi Downloads", "2026-11-22")
own_video = touch(os.path.join(TMP, "mine", "lecture.mkv"))
own_sound = touch(os.path.join(TMP, "mine", "talk.wav"))

check("empty history gives an empty library", library.items() == [])

# Home saves: a link saved as MP4 (its sound kept), an own file saved as MP3
mp4 = touch(os.path.join(saved_dir, "Desert water.mp4"))
link_saved = history.add_history("https://www.youtube.com/watch?v=abc", "Desert water",
                                 touch(os.path.join(history.new_history_folder(), "original.mka")), mp4)
mp3 = touch(os.path.join(saved_dir, "talk.mp3"))
own_saved = history.add_history(own_sound, "talk.wav", None, mp3)
# Played: a TikTok link, an own video, an own sound
link_play, link_folder = played("https://www.tiktok.com/@a/video/1", "Mountains")
video_play, video_folder = played(own_video, "lecture.mkv")
sound_play, _ = played(own_sound, "talk.wav")

i = by_id(link_saved)
check("saved link: ready, video, YouTube, MP4", (i["state"], i["kind"], i["from"], i["format"]) ==
      ("ready", "video", "YouTube", "MP4"), str(i))
check("saved link: Show in folder = the saved file", i["show"] == os.path.normpath(mp4))
i = by_id(own_saved)
check("own file saved as MP3: audio, 'Your file', MP3", (i["state"], i["kind"], i["from"], i["format"]) ==
      ("ready", "audio", "Your file", "MP3"), str(i))
i = by_id(link_play)
check("played link: ready, video, TikTok, no format", (i["state"], i["kind"], i["from"], i["format"]) ==
      ("ready", "video", "TikTok", ""), str(i))
check("played item: no Show in folder (its sound is Naqi's own cache)", i["show"] is None)
check("played own video: video", by_id(video_play)["kind"] == "video")
check("played own sound: audio", by_id(sound_play)["kind"] == "audio")
check("newest first", [x["id"] for x in library.items()][:2] == [sound_play, video_play])
check("being cleaned: 'cleaning'", library.items(live_id=video_play)[1]["state"] == "cleaning")

# A saved file moved away: gone (old: greyed, "File moved or deleted")
os.rename(mp3, mp3 + ".moved")
check("saved file moved: gone", by_id(own_saved)["state"] == "gone")
check("gone: no Show in folder", by_id(own_saved)["show"] is None)
os.rename(mp3 + ".moved", mp3)

# The 2 weeks rule: a 15-day-old played link loses its cache and cleans again on Play; its row stays
old_link, old_folder = played("https://youtu.be/xyz", "Old talk", days_old=15)
gone = history.clean_history()
check("clean-up deletes the old item's history folder", gone == 1 and not os.path.exists(old_folder))
i = by_id(old_link)
check("old played link stays in the library as 'again'", i is not None and i["state"] == "again", str(i))
# ... an own file behind a cleaned-up item that was moved: nothing left to play
old_own, _ = played(own_video, "lecture.mkv", days_old=15)
history.clean_history()
os.rename(own_video, own_video + ".moved")
check("cleaned-up own video, file moved: gone", by_id(old_own)["state"] == "gone")
os.rename(own_video + ".moved", own_video)
check("... and 'again' once the file is back", by_id(old_own)["state"] == "again")
# ... a played item that was saved too plays its saved file (MP4 first) when the cache is gone
saved_too, _ = played("https://youtu.be/def", "Saved too", days_old=15)
history.add_saved(saved_too, touch(os.path.join(saved_dir, "Saved too.mp3")))
history.add_saved(saved_too, touch(os.path.join(saved_dir, "Saved too.mp4")))
history.clean_history()
i = by_id(saved_too)
check("cache gone but saved: ready, plays the MP4", i["state"] == "ready" and i["kind"] == "video", str(i))
check("... format and Show in folder = newest saved file", i["format"] == "MP4" and i["show"].endswith("Saved too.mp4"))

# The 5 GB rule seen from the library: with a tiny limit only the newest kept folders stay
history.HISTORY_MAX_BYTES = 2500
history.clean_history()
states = {x["id"]: x["state"] for x in library.items()}
check("5 GB rule: the newest played item stays ready", states[sound_play] == "ready")
check("5 GB rule: older played items clean again", states[link_play] == "again", str(states))
history.HISTORY_MAX_BYTES = 5 * 10**9

# Ratings (T3.2): Bad / Good / Perfect saved in the history row and shown by the library; anything else refused
check("not rated yet: empty rating", by_id(sound_play)["rating"] == "")
for value in ("bad", "good", "perfect"):
    shown = library.rate(sound_play, value)
    check(f"rate {value}: saved and shown", shown["rating"] == value and history.get_row(sound_play)["rating"] == value
          and by_id(sound_play)["rating"] == value)
check("rating the item being cleaned keeps its state", library.rate(video_play, "good", live_id=video_play)["state"] == "cleaning")
for bad_value in ("", "great", None, 3):
    try:
        library.rate(sound_play, bad_value)
        check(f"rating {bad_value!r} is refused", False)
    except ValueError:
        check(f"rating {bad_value!r} is refused", history.get_row(sound_play)["rating"] == "perfect")
try:
    library.rate(999999, "good")
    check("rating an item that is not there is refused", False)
except ValueError:
    check("rating an item that is not there is refused", True)

# Remove: row + its history folder; saved files and own files stay
try:
    library.remove(video_play, live_id=video_play)
    check("removing the item being cleaned is refused", False)
except ValueError:
    check("removing the item being cleaned is refused", by_id(video_play) is not None)
library.remove(video_play)
check("remove: row gone", by_id(video_play) is None)
check("remove: its history folder gone", not os.path.exists(video_folder))
check("remove: the own file stays", os.path.isfile(own_video))
library.remove(link_saved)
check("remove a saved item: the saved MP4 stays", os.path.isfile(mp4))
try:
    library.remove(link_saved)
    check("removing twice is refused", False)
except ValueError:
    check("removing twice is refused", True)
known = {os.path.normcase(history.history_folder(r)) for r in history.recent_history(999) if history.history_folder(r)}
left = {os.path.normcase(os.path.join(history.HISTORY_DIR, f)) for f in os.listdir(history.HISTORY_DIR)}
check("no history folder left without its row", left <= known, str(left - known))

print(f"\n{'All checks pass' if not failed else f'{failed} check(s) FAILED'} ({TMP})")
sys.exit(1 if failed else 0)
