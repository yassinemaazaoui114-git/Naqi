"""Slip cases (old Naqi SPEC R11), copied from old Naqi app.py with no Qt code (ROADMAP T0.3).
A moment where Naqi got it wrong is a permanent test case: one row in DATA_DIR\\slip_cases.csv plus a copy of its
sound in DATA_DIR\\cases (old Naqi kept the CSV next to the app; here it is in the data folder, SPEC R6).
Cases are never deleted.
"""
import csv
import datetime
import glob
import hashlib
import json
import os
import shutil
import subprocess

from files import AUDIO_EXTS, DATA_DIR, NOWIN, is_link

CASES_CSV = os.path.join(DATA_DIR, "slip_cases.csv")
CASES_DIR = os.path.join(DATA_DIR, "cases")
CASES_HEAD = ["source", "start", "end", "expect", "note", "added"]
# expect: "music" = should have been removed; the others = should have stayed
SLIP_KINDS = [("music", "Music heard"), ("speech", "Talking cut"), ("singing", "Singing cut"),
              ("effects", "Other sound cut")]


def source_link(path):
    """The link a downloaded file was made from (yt-dlp writes it into the tags, cleaning keeps them), or None for
    the user's own files."""
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format_tags=purl,comment", "-of", "json",
                              path], capture_output=True, text=True, encoding="utf-8", stdin=subprocess.DEVNULL,
                             creationflags=NOWIN, timeout=30).stdout
        tags = json.loads(out or "{}").get("format", {}).get("tags", {})
    except Exception:
        return None
    for key in ("purl", "comment"):   # purl = the video's page; older files may only have it in the comment
        value = (tags.get(key) or tags.get(key.upper()) or "").strip()
        if is_link(value) and " " not in value:
            return value
    return None


def case_key(source):
    return hashlib.sha1(source.encode("utf-8")).hexdigest()[:12]


def case_audio(source, kept=None):
    """Local copy of a case's sound (downloaded or copied once, so the case keeps working if the original moves or
    the video is deleted). Videos keep only their sound (FLAC), so a big video is not copied whole.
    kept: the original sound the history kept for this link, used instead of downloading it again."""
    folder = os.path.join(CASES_DIR, case_key(source))
    have = [f for f in glob.glob(os.path.join(folder, "*")) if not f.endswith(".part")]
    if have:
        return have[0]
    os.makedirs(folder, exist_ok=True)
    if kept and os.path.isfile(kept):
        dst = os.path.join(folder, os.path.basename(kept))
        shutil.copyfile(kept, dst + ".part")
        os.replace(dst + ".part", dst)
        return dst
    if is_link(source):
        from downloads import download_audio   # the yt-dlp part of the engine (ROADMAP T0.4)
        return download_audio(source, folder)
    name = os.path.splitext(os.path.basename(source))[0]
    if source.lower().endswith(AUDIO_EXTS):
        dst = os.path.join(folder, os.path.basename(source))
        shutil.copyfile(source, dst + ".part")
    else:
        dst = os.path.join(folder, name + ".flac")
        r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", source, "-map", "0:a:0", "-vn", "-c:a", "flac",
                            "-f", "flac", dst + ".part"], capture_output=True, stdin=subprocess.DEVNULL,
                           creationflags=NOWIN)
        if r.returncode:
            if os.path.exists(dst + ".part"):
                os.remove(dst + ".part")
            raise ValueError("This file has no sound that can be read.")
    os.replace(dst + ".part", dst)
    return dst


def read_cases():
    if not os.path.exists(CASES_CSV):
        return []
    with open(CASES_CSV, encoding="utf-8", newline="") as f:
        return [r for r in csv.DictReader(f) if r.get("source")]


def save_case(source, start, end, expect, note="", kept=None):
    """Saves a slip as a permanent test case: one row in slip_cases.csv plus a copy of the sound (from `kept`, the
    history's copy, when given). Raises ValueError with a message for the user when something is wrong. Slow (copy
    or download), so not on the server's request thread."""
    import speech_only
    if expect not in dict(SLIP_KINDS):
        raise ValueError(f"What went wrong must be one of: {', '.join(dict(SLIP_KINDS))}.")
    if not is_link(source):
        source = os.path.normpath(os.path.abspath(source))
        if not os.path.isfile(source):
            raise ValueError(f"File not found: {source}")
    start, end, note = start.strip(), end.strip(), " ".join(note.split())
    try:
        a, b = speech_only.parse_time(start), speech_only.parse_time(end)
    except ValueError:
        raise ValueError("Write the times like 1:23 (minutes:seconds) or 83.5 (seconds).")
    if a < 0 or b <= a:
        raise ValueError("'To' must be after 'From'.")
    if any(c["source"] == source and c["expect"] == expect and abs(speech_only.parse_time(c["start"]) - a) < 0.5
           and abs(speech_only.parse_time(c["end"]) - b) < 0.5 for c in read_cases()):
        raise ValueError("This slip is already saved.")
    length = speech_only.duration_of(case_audio(source, kept))
    if length and b > length + 1:
        raise ValueError(f"The sound is only {int(length // 60)}:{length % 60:04.1f} long.")
    os.makedirs(DATA_DIR, exist_ok=True)
    new = not os.path.exists(CASES_CSV)
    with open(CASES_CSV, "a", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        if new:
            w.writerow(CASES_HEAD)
        w.writerow([source, start, end, expect, note, datetime.date.today().isoformat()])
    return len(read_cases())


# ---- "Report a slip" page (ROADMAP T5.1): old Naqi SlipPage.choose / set_source / job, without Qt
SRC_HINT = "For your own files, pick the original (not the cleaned copy)."


def _from_row(r):
    """A file from the history: a link uses the original sound kept at cleaning time (no download needed)."""
    kept = bool(r["sound"] and os.path.isfile(r["sound"]))
    if is_link(r["source"]):
        hint = "its original sound, kept when it was cleaned, is used." if kept else \
            "its kept sound was already deleted, so it will be downloaded again."
    else:
        hint = "your own file." if os.path.isfile(r["source"]) else "your own file, but it was moved or deleted."
    return {"source": r["source"], "row": r["id"], "title": r["title"], "download": is_link(r["source"]) and not kept,
            "hint": f"From your recent files: {r['title']}, {hint}"}


def pick_source(row=None, path=None):
    """What a report is about: a history row (row id), or a file picked on disk (path). A file Naqi cleaned is found
    in the history; an older result from a link carries the link in its tags, so the case is made from the original
    sound, downloaded again. Returns {source, row, title, download, hint}: row is None when it is not in the history,
    download = saving it downloads the sound."""
    import history
    if row is not None:
        r = history.get_row(row)
        if not r:
            raise ValueError("Not in the library any more.")
        return _from_row(r)
    if not path or not isinstance(path, str):
        raise ValueError("Give a row or a path.")
    try:
        r = history.find_history(path)
    except Exception:
        r = None
    if r:
        return _from_row(r)
    from downloads import site_name
    link = source_link(path)
    return {"source": link or os.path.normpath(path), "row": None, "title": None, "download": bool(link),
            "hint": f"{os.path.basename(path)} was made from this {site_name(link)} link; its original sound will be "
                    "downloaded." if link else SRC_HINT}


def report(spec):
    """Saves one slip from the page: {source, start, end, expect, note, row}. row = the history row it was picked
    from (its kept sound is used, and the row is marked reported). Returns {count}; ValueError = a message for the
    user. Slow (copy or download): the server answers it on the request's own thread."""
    import history
    source = (spec.get("source") or "").strip()
    start, end = str(spec.get("start") or ""), str(spec.get("end") or "")
    for empty, msg in ((not source, "Paste the link or pick the file first."),
                       (not start.strip(), "Write when the slip starts, e.g. 1:23."),
                       (not end.strip(), "Write when the slip ends, e.g. 1:26.")):
        if empty:
            raise ValueError(msg)
    r = history.get_row(spec["row"]) if isinstance(spec.get("row"), int) else None
    r = r if r and r["source"] == source else None   # the source was edited after picking: not that row any more
    kept = r["sound"] if r and r["sound"] and os.path.isfile(r["sound"]) else None
    n = save_case(source, start, end, spec.get("expect") or "", str(spec.get("note") or ""), kept)
    if r:
        history.mark_reported(r["id"])
    return {"count": n}
