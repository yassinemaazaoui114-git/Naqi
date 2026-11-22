"""Test of Save in the player (ROADMAP T4.3, engine/saves.py): a played item saved as MP3 / MP4 from its cleaned-sound
cache, nothing cleaned again. Own 5 min video (Original, 480p) and 9 min Xvid, MP3, a 19 s YouTube link (MP3 and
MP4 720p: its video downloaded only now, then deleted), "(2)" names, refusals (not all clean, MP4 of a sound, a
second Save at once), Cancel during the encoding and the download (no half file, no downloaded video left), the
saved files remembered, and the item playing its MP4 once its cache is gone. Prints each time.
The caches are the sources' own sound written as cleaned.wav (Save only re-encodes it, so no graphics card is
needed and the times are the same as with a real cleaned sound). Runs in a new temporary data folder (NAQIE_DATA).
Needs internet (the link) and samples/sync_test_5min.mp4 + samples/codecs_long/xvid_9min.avi.
Optional: NAQI_LONG_LINK=<a ~9.5 min YouTube link> also times its 720p MP4 (old Naqi: about 41 s).
Run: py -3.12 engine/test_saves.py   (exit code 0 when all pass)
"""
import os
import subprocess
import sys
import tempfile
import time

TMP = tempfile.mkdtemp(prefix="naqie-save-")
os.environ["NAQIE_DATA"] = os.path.join(TMP, "data")
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import downloads   # noqa: E402  (after NAQIE_DATA is set)
import history     # noqa: E402
import library     # noqa: E402
import player      # noqa: E402
import saves       # noqa: E402
import speech_only  # noqa: E402

SAMPLES = os.path.join(os.path.dirname(HERE), "samples")
VIDEO = os.path.join(SAMPLES, "sync_test_5min.mp4")
XVID = os.path.join(SAMPLES, "codecs_long", "xvid_9min.avi")
LINK = "https://www.youtube.com/watch?v=jNQXAC9IVRw"   # "Me at the zoo", 19 s
OUT = os.path.join(TMP, "saved")
failed = 0
events = []


def check(name, ok, detail=""):
    global failed
    failed += not ok
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""), flush=True)


def emit(event, data):
    events.append((event, data))


def cache_of(src, folder):
    """A cleaned.wav like clean_to_wav writes (16-bit, 44.1 kHz stereo, 44-byte header) from src's sound."""
    path = os.path.join(folder, history.CACHE_NAME)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-vn", "-map_metadata", "-1", "-bitexact",
                    "-ac", "2", "-ar", str(speech_only.SR), "-c:a", "pcm_s16le", path], check=True)
    return path


def played(source, src_sound=None, title=None):
    """A "Clean and play" item whose cache is there and finished."""
    folder = history.new_history_folder()
    sound = None
    if source.startswith("http"):
        sound, title = downloads.download_sound(source, folder, lambda d: None)
    cache = cache_of(src_sound or sound or source, folder)
    return history.add_history(source, title or os.path.basename(source), sound, cache)


def length(path):
    """Length of the sound track (a video's picture can be longer than its sound, also in the source)."""
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration",
                          "-of", "csv=p=0", path], capture_output=True, text=True)
    try:
        return float(out.stdout.strip())
    except ValueError:
        return speech_only.duration_of(path)


def probe(path, what):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", what, "-show_entries",
                          "stream=codec_name,width,height", "-of", "csv=p=0", path], capture_output=True, text=True)
    return out.stdout.strip()


def tag(path, key):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", f"format_tags={key}", "-of", "csv=p=0", path],
                         capture_output=True, text=True)
    return out.stdout.strip()


s = saves.Saves(emit)


def run(row_id, cancel_when=None, **spec):
    """Start a Save, wait for its end; cancel_when(item) -> True cancels it. Returns (item, seconds)."""
    t0 = time.time()
    item = s.start(row_id, dict({"out": OUT, "size": "Original", "kbps": 192}, **spec))
    while True:
        cur = s.get(item["id"])
        if cur["state"] != "running":
            return cur, time.time() - t0
        if cancel_when and cancel_when(cur):
            s.stop(item["id"])
            cancel_when = None
        time.sleep(0.05)


def day_files():
    return sorted(os.listdir(os.path.join(OUT, os.listdir(OUT)[0]))) if os.path.isdir(OUT) and os.listdir(OUT) else []


own = played(VIDEO)
cache = history.get_row(own)["result"]
mtime = os.path.getmtime(VIDEO)

# ----- MP3 of an own video -----
item, sec = run(own, fmt="mp3")
check("MP3 of 5 min own video saved", item["state"] == "done" and os.path.isfile(item["path"] or ""), f"{sec:.1f} s")
check("MP3 length = cache length", abs(length(item["path"]) - length(cache)) < 0.1,
      f"{length(item['path']):.2f} vs {length(cache):.2f}")
check("saved into the day folder", os.path.basename(os.path.dirname(item["path"])) == time.strftime("%Y-%m-%d"))
check("MP3 has no picture", not probe(item["path"], "V"))
mp3 = item["path"]

# ----- MP4 Original: picture copied -----
item, sec = run(own, fmt="mp4")
check("MP4 Original saved", item["state"] == "done", f"{sec:.1f} s")
check("MP4 Original picture copied (h264 1920x1080)", probe(item["path"], "V") == probe(VIDEO, "V"),
      probe(item["path"], "V"))
check("MP4 sound is AAC", probe(item["path"], "a") == "aac")
check("MP4 sound length = cache length", abs(length(item["path"]) - length(cache)) < 0.1,
      f"{length(item['path']):.2f} vs {length(cache):.2f}")
mp4 = item["path"]

# ----- MP4 480p: picture shrunk; same name gets (2) -----
item, sec = run(own, fmt="mp4", size="480p")
check("MP4 480p saved", item["state"] == "done", f"{sec:.1f} s")
check("MP4 480p is 480 lines", probe(item["path"], "V").endswith(",480"), probe(item["path"], "V"))
check('second MP4 named "(2)"', item["path"].endswith(" (2).mp4"), os.path.basename(item["path"]))
check("own file never changed", os.path.getmtime(VIDEO) == mtime)

r = history.get_row(own)
check("history remembers the 3 saved files", history.saved_files(r) == [mp3, mp4, item["path"]],
      repr(r["saved"]))
check("library shows the newest saved format", library.item(r)["format"] == "MP4")
check("library Show in folder = newest saved file", library.item(r)["show"] == item["path"])
check("save events sent", any(e == "save" and d["state"] == "done" for e, d in events))

# ----- Refusals -----
def refused(name, fn, words):
    try:
        fn()
        check(name, False, "not refused")
    except (ValueError, saves.Busy) as e:
        check(name, words in str(e), str(e))


refused("not all clean (live item)", lambda: s.start(own, {"fmt": "mp3", "out": OUT}, live_id=own),
        "ready when all of it is clean")
audio_row = played(os.path.join(SAMPLES, "narration_30s.mp3"))
refused("MP4 of a sound file", lambda: s.start(audio_row, {"fmt": "mp4", "out": OUT}), "no picture")
refused("bad format", lambda: s.start(own, {"fmt": "wav", "out": OUT}), "not right")
item, sec = run(audio_row, fmt="mp3", kbps=320)
check("MP3 320 kbps of an own MP3", item["state"] == "done", f"{sec:.1f} s")

# A second Save while one runs
long_row = played(XVID)
first = s.start(long_row, {"fmt": "mp4", "out": OUT})
refused("second Save at once", lambda: s.start(own, {"fmt": "mp3", "out": OUT}), "Another file is being saved")
s.stop(first["id"])
while s.get(first["id"])["state"] == "running":
    time.sleep(0.05)

# ----- Cancel during the encoding -----
before = set(day_files())
item, sec = run(long_row, fmt="mp4", cancel_when=lambda it: it["frac"] > 0.2)
check("cancel during encoding", item["state"] == "cancelled" and item["text"] == "Not saved.", f"{sec:.1f} s")
check("cancel left no file", set(day_files()) == before, str(set(day_files()) - before))

# ----- 9 min Xvid: MP3 and MP4 Original -----
item, sec = run(long_row, fmt="mp3")
check("MP3 of 9 min video", item["state"] == "done", f"{sec:.1f} s")
item, sec = run(long_row, fmt="mp4")
check("MP4 Original of 9 min Xvid", item["state"] == "done", f"{sec:.1f} s, {probe(item['path'], 'V')}")

# ----- A link: MP3, MP4 720p (video downloaded on Save only), cancel during the download -----
link_row = played(LINK)
folder = history.history_folder(history.get_row(link_row))
item, sec = run(link_row, fmt="mp3")
check("MP3 of a 19 s link", item["state"] == "done", f"{sec:.1f} s")
check("link MP3 tags: title and link", tag(item["path"], "title") and LINK in tag(item["path"], "comment"),
      tag(item["path"], "title"))
item, sec = run(link_row, fmt="mp4", size="720p")
check("MP4 720p of a 19 s link", item["state"] == "done", f"{sec:.1f} s, {probe(item['path'], 'V')}")
check("link MP4 has picture + AAC", probe(item["path"], "V") and probe(item["path"], "a") == "aac")
check("link MP4 tagged with its link", LINK in tag(item["path"], "comment"))
check("downloaded video deleted", not [f for f in os.listdir(folder) if f.startswith("video.")], str(os.listdir(folder)))
link_mp4 = item["path"]
seen = []
item, sec = run(link_row, fmt="mp4", size="480p",
                cancel_when=lambda it: (seen.append(it["text"]), it["text"].startswith("Downloading"))[1])
check("cancel during the download", item["state"] == "cancelled", f"{sec:.1f} s, first text {seen[:1]}")
check("cancelled download left nothing", not [f for f in os.listdir(folder) if f.startswith("video.")],
      str(os.listdir(folder)))

# ----- The cache tidied away: the item plays its saved MP4 -----
os.remove(history.get_row(link_row)["result"])
r = history.get_row(link_row)
check("cache gone: plays the saved MP4", history.play_path(r) == link_mp4, history.play_path(r))
check("cache gone: state ready, not again", library.item(r)["state"] == "ready")
check("cache gone: Save not ready, says why", not player.save_info(r)["ready"] and "tidied" in player.save_info(r)["why"],
      player.save_info(r)["why"])

# ----- Optional: the long link of old Naqi's measure -----
long_link = os.environ.get("NAQI_LONG_LINK")
if long_link:
    t0 = time.time()
    row = played(long_link)
    print(f"     (long link sound downloaded in {time.time() - t0:.1f} s, {length(history.get_row(row)['result']):.0f} s long)")
    item, sec = run(row, fmt="mp3")
    check("MP3 of the long link", item["state"] == "done", f"{sec:.1f} s")
    item, sec = run(row, fmt="mp4", size="720p")
    check("MP4 720p of the long link", item["state"] == "done", f"{sec:.1f} s, {probe(item['path'], 'V')}")

print(f"\n{'ALL PASS' if not failed else f'{failed} FAILED'}  (temp folder {TMP})")
sys.exit(1 if failed else 0)
