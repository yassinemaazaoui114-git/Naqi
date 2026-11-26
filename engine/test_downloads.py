"""Test of the engine's download logic (ROADMAP T0.4). Needs the internet: downloads a 19 s YouTube video's sound
and picture into a temporary folder, and checks the plain-words errors on links that cannot work.
Run: py -3.12 engine/test_downloads.py   (prints each check, exit code 0 when all pass)
"""
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import downloads   # noqa: E402
from yt_dlp.utils import DownloadCancelled, DownloadError   # noqa: E402

SHORT = "https://www.youtube.com/watch?v=jNQXAC9IVRw"   # "Me at the zoo", 19 s, public since 2005
GONE = "https://www.youtube.com/watch?v=aaaaaaaaaaa"     # no such video
UNSUPPORTED = "https://example.com/"                    # a page with no video

TMP = tempfile.mkdtemp(prefix="naqie-dl-")
failed = 0


def check(name, ok, detail=""):
    global failed
    failed += not ok
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""))


def error_of(fn):
    """The plain-words message the window would show for a failing download."""
    try:
        fn()
    except (DownloadError, RuntimeError, ValueError) as ex:
        return downloads.link_error(str(ex))
    return None


# ----- helpers, no internet -----
check("site name YouTube", downloads.site_name("https://youtu.be/x") == "YouTube")
check("site name TikTok", downloads.site_name("https://www.tiktok.com/@a/video/1") == "TikTok")
check("site name other = domain", downloads.site_name("https://www.vimeo.com/1") == "vimeo.com")
check("playlist link", downloads.is_playlist_link("https://www.youtube.com/watch?v=a&list=PL1"))
check("playlist only", downloads.is_playlist_only("https://www.youtube.com/playlist?list=PL1"))
check("video in playlist is not playlist-only",
      not downloads.is_playlist_only("https://www.youtube.com/watch?v=a&list=PL1"))
check("other site never a playlist", not downloads.is_playlist_link("https://vimeo.com/1?list=2"))
check("login error in plain words", "needs a login" in downloads.link_error("ERROR: Sign in to confirm your age"))
check("country block in another language", "blocked in your country" in downloads.link_error(
    "ERROR: [dailymotion] xhza0o: Le propriétaire de cette vidéo ne souhaite pas la diffuser dans votre pays.\n"
    "This video is available in France.\nYou might want to use a VPN"))
check("colour codes removed", downloads.link_error("\x1b[0;31mERROR:\x1b[0m boom") == "boom")
check("TikTok helper (curl_cffi) installed", downloads.has_impersonate())
info = {"playlist_autonumber": 2, "n_entries": 4}
frac, text = downloads.playlist_progress(info, 0.5, "Downloading… 50%")
check("playlist progress spread", abs(frac - 0.375) < 1e-9 and text == "Video 2 of 4: Downloading… 50%")

# ----- "Clean and play": the sound of a short link, with progress -----
events = []
hook = downloads.progress_hook(lambda f, t, i: events.append((round(f, 3), t)), lambda: False,
                               share=downloads.SOUND_SHARE, text="Downloading the sound…", finished=None)
folder = os.path.join(TMP, "play")
os.makedirs(folder)
t0 = time.time()
path, title = downloads.download_sound(SHORT, folder, hook)
took = time.time() - t0
check("sound downloaded", os.path.isfile(path) and os.path.getsize(path) > 10_000,
      f"{os.path.basename(path)}, {os.path.getsize(path) // 1024} KB, {took:.1f} s")
check("title read", title == "Me at the zoo", title)
check("progress reported", len(events) >= 1, f"{len(events)} events, last {events[-1] if events else None}")
check("progress grows to the sound share", events and events[-1][0] == downloads.SOUND_SHARE
      and all(a[0] <= b[0] for a, b in zip(events, events[1:])))
check("progress text like old Naqi", events and events[-1][1] == "Downloading the sound… 100%")

# ----- cancel stops the download -----
try:
    downloads.download_sound(SHORT, os.path.join(TMP, "cancel"),
                             downloads.progress_hook(lambda *a: None, lambda: True))
    check("cancel stops the download", False)
except (DownloadCancelled, DownloadError) as ex:
    check("cancel stops the download", "Cancelled" in str(ex), type(ex).__name__)

# ----- player picture: streamed, not downloaded -----
url, headers, start, _ = downloads.video_stream(SHORT)
check("video stream address", bool(url) and url.startswith("https://"), f"{len(headers)} headers")

# ----- Save: the picture only, 240 lines at most -----
events.clear()
video = downloads.download_video(SHORT, os.path.join(TMP, "save"), 240,
                                 downloads.progress_hook(lambda f, t, i: events.append((f, t)), lambda: False,
                                                         share=0.7))
check("video downloaded", os.path.isfile(video), os.path.basename(video))
check("save progress ends 'Preparing the file…'", events and events[-1] == (0.7, "Preparing the file…"))

# ----- errors in plain words -----
msg = error_of(lambda: downloads.download_sound(UNSUPPORTED, os.path.join(TMP, "e1"), lambda d: None))
check("unsupported link message", msg and msg.startswith("Naqi can't download from this link"), msg)
msg = error_of(lambda: downloads.download_sound(GONE, os.path.join(TMP, "e2"), lambda d: None))
check("missing video gives a clear message", bool(msg) and "Traceback" not in msg, msg)

shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{'ALL PASSED' if not failed else f'{failed} FAILED'}")
sys.exit(1 if failed else 0)
