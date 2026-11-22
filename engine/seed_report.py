"""Fills a test data folder (NAQIE_DATA, never the real one) for the window's report self-test (NAQI_SELFTEST=report,
ROADMAP T5.1, T5.2): a played link whose original sound was kept (its cleaned sound has a muted gap), a played link
whose kept sound and cleaned sound are gone, an own file saved as MP3, plus two files that are not in the history (an own video, and a video made from a link, with the link in its
comment tag as yt-dlp leaves it in an MP4). Uses samples/narration_30s.mp3 and samples/codecs/h264.mp4. Prints the
paths and row ids as JSON.
Run: NAQIE_DATA=<test folder> py -3.12 engine/seed_report.py <folder for the test files>
"""
import json
import os
import shutil
import subprocess
import sys

if not os.environ.get("NAQIE_DATA"):
    sys.exit("NAQIE_DATA must point to a test data folder")
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
import history  # noqa: E402

samples = os.path.join(here, "..", "samples")
sound = os.path.join(samples, "narration_30s.mp3")
video = os.path.join(samples, "codecs", "h264.mp4")
out = os.path.abspath(sys.argv[1])
shutil.rmtree(os.environ["NAQIE_DATA"], ignore_errors=True)
shutil.rmtree(out, ignore_errors=True)


def copy(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(src, dst)
    return os.path.normpath(dst)


def played(source, title, kept):
    """A played link. Its cleaned sound (the cache) is the sample with 10 s to 14 s muted, as Naqi mutes music;
    without a kept sound its cache is gone too (cleaned up: it would be cleaned again)."""
    folder = history.new_history_folder()
    cache = os.path.join(folder, history.CACHE_NAME)
    if kept:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", sound, "-af", "volume=0:enable='between(t,10,14)'",
                        "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", cache], check=True)
    keep = copy(sound, os.path.join(folder, title + ".mp3")) if kept else None
    return history.add_history(source, title, keep, cache), keep


own = copy(sound, os.path.join(out, "mine", "Friday talk.mp3"))
cleaned = copy(sound, os.path.join(out, "Naqi Downloads", "Friday talk.mp3"))
own_row = history.add_history(own, "Friday talk.mp3", None, cleaned)
old_row, _ = played("https://www.youtube.com/watch?v=oldlecture1", "Old lecture", kept=False)
link_row, kept = played("https://www.youtube.com/watch?v=jNQXAC9IVRw", "How the desert keeps its water", kept=True)
own_video = copy(video, os.path.join(out, "mine", "Holiday clip.mp4"))
tagged = os.path.join(out, "Naqi Downloads", "Made from a link.mp4")
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", video, "-c", "copy", "-metadata",
                "comment=https://www.youtube.com/watch?v=tagged12345", tagged], check=True)
print(json.dumps({"own": own, "cleaned": cleaned, "own_row": own_row, "old_row": old_row, "link_row": link_row,
                  "kept": kept, "own_video": own_video, "tagged": os.path.normpath(tagged)}))
