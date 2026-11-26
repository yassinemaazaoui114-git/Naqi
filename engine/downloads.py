"""Download logic, copied from old Naqi app.py with no Qt code (ROADMAP T0.4): link names and errors in plain words,
playlist helpers, the yt-dlp option sets and the downloads ("Clean and play" sound, streamed picture, Save video).
TikTok works through yt-dlp's `curl_cffi` helper: yt-dlp uses it by itself when it is installed (`has_impersonate`
tells). Progress goes out through `progress_hook`: yt-dlp's hook turned into report(frac, text) calls, the same
texts old Naqi showed; it also stops a download when the job is cancelled.
When a site has changed (site_changed), the downloads get a newer yt-dlp and try once more (`updates`, ytdlp_update).
"""
import functools
import os
import re
import subprocess
import time
import urllib.parse

import ytdlp_update

ytdlp_update.use_newest()   # a newer downloaded yt-dlp, before yt_dlp is imported
import yt_dlp  # noqa: E402
from yt_dlp.utils import DownloadCancelled  # noqa: E402

from files import NOWIN, TITLE_MAX  # noqa: E402

DOWNLOAD_SHARE = 0.4    # part of the progress bar used by the download; the rest is the cleaning
SOUND_SHARE = 0.1       # the same for "Clean and play", which downloads only the sound
# The picture of a link is streamed, not downloaded (SPEC R14d): video only (the cleaned sound replaces its sound),
# up to 1080p ("Auto"), or the size picked in the player's settings menu (SPEC R39). "res" is the shorter side, so a
# standing video (1080 x 1920) is 1080p too
STREAM_FORMAT = "bv/b"
STREAM_AUTO = 1080
STREAM_HEIGHTS = (1080, 720, 480, 360)

# Sites shown by name; any other site yt-dlp can download from works too and is shown by its domain (SPEC R2)
SITE_NAMES = {"youtube.com": "YouTube", "youtu.be": "YouTube", "tiktok.com": "TikTok", "facebook.com": "Facebook",
              "fb.watch": "Facebook", "instagram.com": "Instagram", "x.com": "X", "twitter.com": "X"}


def site_name(url):
    """'YouTube', 'TikTok'... for a link, or its domain (e.g. 'vimeo.com') for other sites."""
    host = (urllib.parse.urlparse(url.strip()).hostname or "").lower()
    for domain, name in SITE_NAMES.items():
        if host == domain or host.endswith("." + domain):
            return name
    return host.removeprefix("www.").removeprefix("m.") or "Link"


def link_error(msg):
    """yt-dlp's error message in plain words. Naqi never uses a login (SPEC R2), so for videos behind one the
    answer is to save them some other way and drop the file in."""
    msg = re.sub(r"\x1b\[[0-9;]*m", "", msg).replace("ERROR: ", "").strip()   # no terminal colour codes
    low = msg.lower()
    if "unsupported url" in low:
        return "Naqi can't download from this link. If you can save the video yourself, drop the file here."
    if any(w in low for w in ("login", "log in", "logged in", "sign in", "cookies", "private", "registered users",
                              "authentication")):
        return ("This video is private or needs a login, so Naqi can't download it. If you can save it yourself, "
                "drop the file here.")
    if "no video" in low or "no media" in low:
        return "This link has no video or sound that Naqi can download."
    if "could not read any audio" in low:
        return ("This video has no sound Naqi can get. Some sites (often Instagram) hide the sound from people who "
                "are not logged in; if you can save the video yourself, drop the file here.")
    # yt-dlp adds "You might want to use a VPN" to every country block, whatever language the site wrote it in
    if any(w in low for w in ("ip address is blocked", "in your country", "geo restrict", "use a vpn")):
        return "This video is blocked in your country, so Naqi can't download it."
    if site_changed(msg):
        return ("Naqi couldn't read this link. The video may be deleted or private, or the site has changed "
                "(a Naqi update usually fixes that).")
    return msg


def site_changed(msg):
    """True when yt-dlp's error says it could not read the site's page: the site has changed, and a newer yt-dlp
    usually reads it again."""
    low = msg.lower()
    return "please report this issue" in low or "unable to extract" in low or "cannot parse" in low


def updates(fn):
    """A download that, when it fails because the site changed, is tried once more with a newer yt-dlp (if there
    is one). The error it gives may be yt-dlp's own or carry it as its cause."""
    @functools.wraps(fn)
    def run(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception as ex:
            if not any(site_changed(str(e)) for e in (ex, ex.__cause__) if e) or not ytdlp_update.fresh():
                raise
        return fn(*args, **kwargs)
    return run


def is_playlist_link(url):
    """Only YouTube playlists are offered as a whole; links to other sites are always one video."""
    return "list=" in url and site_name(url) == "YouTube"


def is_playlist_only(url):
    """Link to a playlist page itself (no single video in it) -> can only be a playlist."""
    if not is_playlist_link(url):
        return False
    return "v=" not in url and "youtu.be/" not in url and "/shorts/" not in url


def has_impersonate():
    """True when yt-dlp can pretend to be a browser (curl_cffi installed), which TikTok needs."""
    try:
        import curl_cffi  # noqa: F401
        return True
    except ImportError:
        return False


class ErrorLog:
    """Collects yt-dlp error messages (used to report skipped playlist videos)."""
    def __init__(self):
        self.errors = []

    def debug(self, msg): pass
    def info(self, msg): pass
    def warning(self, msg): pass

    def error(self, msg):
        self.errors.append(msg.replace("ERROR: ", "").strip())


def progress_hook(report, cancelled, share=DOWNLOAD_SHARE, text="Downloading…", finished="Preparing the file…"):
    """A yt-dlp progress hook. report(frac, text, info): frac 0..share inside the current video, info its yt-dlp
    info (playlist number); cancelled(): True stops the download (DownloadCancelled). finished=None: no line when
    the file is complete (old Naqi's "Clean and play" showed none)."""
    def hook(d):
        if cancelled():
            raise DownloadCancelled("Cancelled by user")
        info = d.get("info_dict", {})
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            frac = d["downloaded_bytes"] / total if total else 0
            report(frac * share, f"{text} {frac * 100:.0f}%", info)
        elif d["status"] == "finished" and finished:
            report(share, finished, info)
    return hook


def playlist_progress(info, part, text):
    """(frac, text) for the whole job: part 0..1 inside the current video, spread over a playlist's videos."""
    idx, n = info.get("playlist_autonumber"), info.get("n_entries")
    if idx and n:
        return ((idx - 1) + part) / n, f"Video {idx} of {n}: {text}"
    return part, text


def build_opts(out, fmt, quality, playlist, hook, logger):
    # Titles are cut to TITLE_MAX characters: some sites (Facebook, TikTok) use the whole post text as the title
    t = f"%(title).{TITLE_MAX}s"
    if playlist:
        # <out>/<Playlist title>/01 - <Video title>.<ext>  (number width follows playlist size)
        tmpl = os.path.join(out, f"%(playlist_title).{TITLE_MAX}s", f"%(playlist_index)s - {t}.%(ext)s")
    else:
        tmpl = os.path.join(out, f"{t}.%(ext)s")
    opts = {
        # pl_thumbnail empty = don't save the playlist's cover image as a stray .jpg
        "outtmpl": {"default": tmpl, "pl_thumbnail": ""},
        "noplaylist": not playlist,
        # One video only: a profile or channel link would otherwise download every video on it
        **({} if playlist else {"playlist_items": "1"}),
        "ignoreerrors": playlist,      # playlist: skip private/deleted videos and keep going
        "windowsfilenames": True,
        "progress_hooks": [hook],
        "logger": logger,
        "quiet": True,
        "no_warnings": True,
    }
    if fmt == "mp3":
        opts.update({
            "format": "bestaudio/best",
            "writethumbnail": True,
            "postprocessors": [
                {"key": "FFmpegExtractAudio", "preferredcodec": "mp3",
                 "preferredquality": quality.split()[0]},
                {"key": "FFmpegMetadata"},
                {"key": "EmbedThumbnail"},
            ],
        })
    else:
        res = "res" if quality == "Best" else f"res:{quality.rstrip('p')}"
        opts.update({
            "format": "bv*+ba/b",
            # Highest resolution up to the cap; prefer H.264/AAC so it plays everywhere
            "format_sort": [res, "vcodec:h264", "acodec:m4a"],
            "merge_output_format": "mp4",
            "postprocessors": [{"key": "FFmpegMetadata"}],
        })
    return opts


def summarize(info, fmt, playlist, errors):
    """Returns (kind, message) for the UI."""
    if info is None:
        return "error", (link_error(errors[-1]) if errors else "Download failed.")
    if not playlist and "entries" in info:   # a post or profile with videos: only the first one was taken
        entries = [e for e in info["entries"] or [] if e]
        if not entries:
            return "error", link_error(errors[-1]) if errors else "This link has no video Naqi can download."
        info = entries[0]
    if not playlist or "entries" not in info:
        return "done", f"{info.get('title', 'file')}.{fmt}"
    entries = list(info.get("entries") or [])
    ok = sum(1 for e in entries if e)
    total = len(entries)
    msg = f"{ok} of {total} videos, in the folder \"{info.get('title', 'playlist')}\""
    if ok < total:
        return "partial", msg + f". {total - ok} skipped (private, deleted or unavailable)."
    return "done", msg


def extract(ydl, url, download=True, tries=3):
    """ydl.extract_info, asked again when the site refuses the file once (HTTP 403): YouTube does that now and then,
    and a new request gets a new address that works."""
    for attempt in range(tries):
        try:
            return ydl.extract_info(url, download=download)
        except yt_dlp.utils.DownloadError as ex:
            if "403" not in str(ex) or attempt == tries - 1:
                raise
            time.sleep(1 + attempt)


@updates
def download_audio(url, out):
    """Best audio of one video into `out`, untouched (no cleaning). Returns the file path."""
    opts = {"format": "bestaudio/best", "noplaylist": True, "playlist_items": "1", "quiet": True,
            "no_warnings": True, "outtmpl": os.path.join(out, "%(id)s.%(ext)s"), "logger": ErrorLog()}
    with yt_dlp.YoutubeDL(opts) as ydl:
        try:
            info = extract(ydl, url)
        except yt_dlp.utils.DownloadError as ex:
            raise ValueError(link_error(str(ex))) from ex
        entries = [e for e in info.get("entries") or [] if e] if "entries" in info else [info]
        if not entries:
            raise ValueError("This link has no video Naqi can download.")
        return ydl.prepare_filename(entries[0])


@updates
def download_sound(url, folder, hook):
    """"Clean and play": the best sound of one video into the history folder `folder`; it is also the kept original
    sound (SPEC R13). A site that only offers a file with its picture keeps only its sound track (copied as it is).
    Returns (path, title). hook: yt-dlp progress hook."""
    import speech_only   # heavy (PyTorch); the engine has it loaded already
    log = ErrorLog()
    opts = {"format": "bestaudio/best", "noplaylist": True, "playlist_items": "1", "quiet": True,
            "no_warnings": True, "outtmpl": os.path.join(folder, "original.%(ext)s"), "progress_hooks": [hook],
            "logger": log}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = extract(ydl, url)
        entries = [e for e in info.get("entries") or [] if e] if info and "entries" in info else [info]
        if not entries or not entries[0]:
            raise RuntimeError(log.errors[-1] if log.errors else "This link has no video Naqi can download.")
        path = ydl.prepare_filename(entries[0])
    if speech_only.video_codec(path):
        sound = os.path.join(folder, "original-sound.mka")
        r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-map", "0:a:0", "-vn", "-c:a", "copy",
                            sound], capture_output=True, stdin=subprocess.DEVNULL, creationflags=NOWIN)
        os.remove(path)
        if r.returncode:
            raise RuntimeError("Could not read any audio from the file.")
        path = sound
    return path, entries[0].get("title") or ""


@updates
def video_stream(url, height=None):
    """The video stream of a link for the player (SPEC R14d, R39): the picture only, at most `height` lines (None =
    Auto, up to 1080p); nothing is downloaded. Returns (address, http headers it needs, time it is served from,
    {"height": the stream's lines, "heights": the sizes of STREAM_HEIGHTS the link has}), or (None, [], 0, {})
    when the link has no picture."""
    opts = {"format": STREAM_FORMAT, "format_sort": [f"res:{height or STREAM_AUTO}"], "noplaylist": True,
            "playlist_items": "1", "quiet": True, "no_warnings": True, "logger": ErrorLog()}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = extract(ydl, url, download=False)
        if info and "entries" in info:
            info = next((e for e in info["entries"] or [] if e), None)
        f = (info.get("requested_formats") or [info])[0] if info else {}
        if not f.get("url") or f.get("vcodec") == "none":
            return None, [], 0, {}
        headers = dict(f.get("http_headers") or {})
        cookie = ydl.cookiejar.get_cookie_header(f["url"])
        if cookie:
            headers["Cookie"] = cookie
    top = max([_lines(x) for x in info.get("formats") or [] if x.get("vcodec") != "none"] or [_lines(f)])
    sizes = {"height": _lines(f), "heights": [h for h in STREAM_HEIGHTS if top >= h]}
    return f["url"], [f"{k}: {v}" for k, v in headers.items()], f.get("available_at") or 0, sizes


def _lines(f):
    """A format's size as the player names it (720 = 720p): its shorter side, 0 when not known."""
    w, h = f.get("width") or 0, f.get("height") or 0
    return min(w, h) if w and h else h or w


@updates
def download_video(url, folder, height, hook):
    """Save (SPEC R14): the picture of one video into `folder`, without its sound (the cleaned sound replaces it).
    At most `height` lines (None = the best there is); H.264 first, so it is copied into the MP4, not re-encoded.
    Returns the file path. hook: yt-dlp progress hook."""
    log = ErrorLog()
    opts = {"format": "bv/b", "format_sort": [f"res:{height}" if height else "res", "vcodec:h264"],
            "noplaylist": True, "playlist_items": "1", "quiet": True, "no_warnings": True,
            "outtmpl": os.path.join(folder, "video.%(ext)s"), "progress_hooks": [hook], "logger": log}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = extract(ydl, url)
        entries = [e for e in info.get("entries") or [] if e] if info and "entries" in info else [info]
        if not entries or not entries[0]:
            raise RuntimeError(log.errors[-1] if log.errors else "This link has no video Naqi can download.")
        return ydl.prepare_filename(entries[0])
