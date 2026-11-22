"""The library side bar's items (ROADMAP T3.1), from the history rows, with old Naqi's rules (app.py LibraryRow,
media_kind, row_meta; old SPEC R13, R14d, R14e). No UI code: the window gets plain dicts.

An item's state:
  "cleaning"  it is being cleaned right now ("Clean and play")
  "ready"     it plays: its cleaned-sound cache, a saved file of it, or its cleaned file is there
  "again"     a played item whose cleaned sound was cleaned up (2 weeks / 5 GB) and that was not saved: it is
              cleaned again on Play (its link, or its own file, is still there)
  "gone"      nothing left to play: the cleaned file was moved or deleted (or the own file behind a played item)
"""
import os

import history
from files import VIDEO_EXTS, is_link


def media_kind(r):
    """'video' or 'audio': what a history row plays. A played link or own video gets its picture back."""
    path = history.play_path(r) or ""
    if history.is_cache(path):
        return "video" if is_link(r["source"]) or r["source"].lower().endswith(VIDEO_EXTS) else "audio"
    return "video" if path.lower().endswith(".mp4") else "audio"


def item(r, live_id=None):
    """One library item for the window."""
    from downloads import site_name   # here, not at the top: yt-dlp takes a second to load and the engine starts first
    live = r["id"] == live_id
    again = not live and history.needs_cleaning(r) and (is_link(r["source"]) or os.path.isfile(r["source"]))
    path = history.play_path(r) or ""
    here = live or again or (bool(r["result"]) and os.path.isfile(path))
    saved = history.saved_files(r)
    shown = saved[-1] if saved else r["result"] or ""
    # "Show in folder": the newest saved file, or a cleaned file the Home page saved; a played-only item has none
    # (its cleaned sound is Naqi's own cache, not a file of the user's)
    show = shown if shown and not history.is_cache(shown) and os.path.isfile(shown) else None
    return {
        "id": r["id"], "title": r["title"] or os.path.basename(r["source"] or ""), "source": r["source"],
        "added": r["added"], "from": site_name(r["source"]) if is_link(r["source"]) else "Your file",
        "kind": media_kind(r),
        "format": "" if history.is_cache(shown) else os.path.splitext(shown)[1][1:].upper(),
        "state": "cleaning" if live else "again" if again else "ready" if here else "gone",
        "show": show, "rating": r.get("rating") or "", "reported": bool(r.get("reported")),
    }


def items(live_id=None):
    """Every cleaned file, newest first (at most history.LIBRARY_MAX). An unreadable history gives an empty list:
    the library is a help, never a reason for the window to fail."""
    try:
        rows = history.recent_history(history.LIBRARY_MAX)
    except Exception:
        return []
    return [item(r, live_id) for r in rows]


RATINGS = ("bad", "good", "perfect")   # old Naqi RATINGS; "" = not rated


def rate(row_id, rating, live_id=None):
    """Saves Bad / Good / Perfect on a library item (old SPEC R13). Raises ValueError for any other value, or an
    item that is not there. Returns the item as the library shows it."""
    if rating not in RATINGS:
        raise ValueError("A rating is bad, good or perfect.")
    if not history.get_row(row_id):
        raise ValueError("Not in the library any more.")
    history.set_rating(row_id, rating)
    return item(history.get_row(row_id), live_id)


def remove(row_id, live_id=None):
    """Takes an item out of the library: its history row and its own history folder (kept original sound,
    cleaned-sound cache, picture copies). Files the user saved and own files are never touched.
    Raises ValueError for the item being cleaned right now, or one that is not there."""
    if row_id == live_id:
        raise ValueError("This one is still being cleaned. Cancel it first.")
    r = history.get_row(row_id)
    if not r:
        raise ValueError("Not in the library any more.")
    folder = history.history_folder(r)
    history.delete_row(row_id)
    if folder:
        history.drop_sound(os.path.join(folder, history.CACHE_NAME))
    return True
