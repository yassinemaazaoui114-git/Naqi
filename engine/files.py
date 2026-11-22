"""Data folder, file kinds and naming helpers, copied from old Naqi app.py with no Qt code (ROADMAP T0.3).
DATA_DIR is %USERPROFILE%\\Naqi-data, old Naqi's folder, so its history carries over (SPEC R6, swap-in T7.2), or
NAQIE_DATA when set (the tests use a temporary folder). NAQI_DATA is not used for this: speech_only.py reads the model
files through it (Naqi-data\\models).
"""
import os
import re
import subprocess

DATA_DIR = os.environ.get("NAQIE_DATA") or os.path.join(os.path.expanduser("~"), "Naqi-data")
NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
AUDIO_EXTS = (".mp3", ".m4a", ".wav", ".flac", ".ogg", ".opus", ".aac", ".wma")
VIDEO_EXTS = (".mp4", ".mkv", ".webm", ".mov", ".avi", ".wmv", ".m4v")
MEDIA_EXTS = AUDIO_EXTS + VIDEO_EXTS
TITLE_MAX = 80          # longest video title used in a file name (characters)


def is_link(source):
    return source.startswith(("http://", "https://"))


def unique_path(path):
    """`path`, or "name (2).ext", "name (3).ext"... when it already exists, so nothing is ever overwritten."""
    base, ext = os.path.splitext(path)
    n = 2
    while os.path.exists(path):
        path = f"{base} ({n}){ext}"
        n += 1
    return path


def guess_kind(path):
    """'audio' or 'video' from the file name; checked for real (ffprobe) right after the file is added."""
    return "audio" if path.lower().endswith(AUDIO_EXTS) else "video"


def real_kind(path):
    """'video' when the file has a real picture (a cover image does not count), else 'audio'; the name's guess when
    ffprobe cannot read it. An MP4 can be sound only, an MP3 can carry a cover (old Naqi's probe after adding)."""
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries",
                              "stream=codec_name:stream_disposition=attached_pic", "-of", "csv=p=0", path],
                             capture_output=True, text=True, stdin=subprocess.DEVNULL, creationflags=NOWIN,
                             timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return guess_kind(path)
    if out.returncode:
        return guess_kind(path)
    pictures = [line for line in out.stdout.splitlines() if line.strip() and not line.strip().endswith(",1")]
    return "video" if pictures else "audio"


def file_name(title):
    """A video title as a Windows file name (no \\ / : * ? " < > |, at most TITLE_MAX characters)."""
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", title or "")[:TITLE_MAX].strip(" .")
    return name or "Naqi"
