"""Music removal (no UI): take the music out, keep talking, singing and every other sound (SPEC R7).
1. Mel-Band Roformer pulls the voice (talking or singing) out of the mix.
2. Bandit v2 listens to what is left and keeps the sound effects (footsteps, rain, laughter...); the rest is music.
3. Music-trace check: where a faint rest of the music could still be heard, that moment is muted (not cut, so
   video stays in sync). When unsure it mutes (SPEC R7a).
4. ffmpeg writes the cleaned audio back into the same file (MP3, or MP4 with the video copied untouched
   unless a smaller size was asked for).
   Or, to play while cleaning (clean_to_wav, SPEC R14): the cleaned sound goes chunk by chunk into a WAV file,
   saved later as MP3 or MP4 by save_wav without cleaning again.
On the GPU when there is one. Requires: torch, torchaudio, einops, rotary-embedding-torch, beartype, ffmpeg, and
the two model files (MODEL_FILES) in models/ or in %USERPROFILE%\\Naqi-data\\models.
The old "talking only" method (Demucs + Silero VAD) is kept at the end of this file, for the benchmarks only.
"""
import os
import struct
import subprocess
import sys
import tempfile
import threading
import time

import numpy as np
import torch
import torch.nn.functional as F
from torchaudio.functional import resample

SR = 44100            # sample rate everything is processed at
BANDIT_SR = 48000     # Bandit v2 works at 48 kHz
PIECE_S = 8           # both models work on 8 s pieces...
JOIN_S = 1            # ...and neighbouring pieces share 1 s, cross-faded
BLOCK_S = 240         # the file is processed in blocks, so memory use does not grow with the video's length
MARGIN_S = 2          # extra audio around each block, thrown away after, so block edges are clean
FADE_S = 0.03         # fade in/out at each mute edge (no clicks)
MP4_VIDEO = {"h264", "hevc", "av1", "vp9", "mpeg4"}   # video codecs an MP4 can hold as they are

# Play while cleaning (SPEC R14a-c): the sound is cleaned in growing chunks, so playback can start after the first
CHUNKS_S = [120, 300, 300]   # chunk sizes; the last one repeats (5 min, not 15: T10.9, the clean part grows ~every 40 s)...
MIN_LAST_S = 180             # ...and a shorter last piece is merged into the one before
CUT_SEARCH_S = 10            # each cut goes at the quietest 200 ms of the mix within this far of its planned time
XFADE_S = 0.05               # neighbouring chunks overlap this much, cross-faded (no click at a seam)
PLAY_SLACK = 1.25            # playback starts only if the cleaning would stay ahead even this much slower...
PLAY_LEAD_S = 5              # ...and at least this many seconds ahead of the playhead

# Music-trace check (SPEC R7a). The models only make music 20-28 dB quieter, so where music plays and little else
# was kept, what was kept is mostly a rest of the music. Every 10 ms: when the music that was taken out is audible
# and the kept sound is not louder than "that music + TRACE_MARGIN_DB", the moment is muted. Tuned on the 140
# test mixes of r7_bench.py (SPEC section 6).
TRACE_HOP = 441            # one decision per 10 ms
TRACE_WINDOW = 8820        # loudness is measured over 200 ms
TRACE_FLOOR_DB = -60.0     # removed music quieter than this leaves nothing to hear
TRACE_MARGIN_DB = -8.0     # higher = mutes more
TRACE_BRIDGE = 41          # muted gaps shorter than this many 10 ms steps inside kept sound are not muted
                           # (quiet syllables and word ends between louder ones)

MODEL_FILES = {"voice": "MelBandRoformer.ckpt", "effects": "bandit_v2_multi.ckpt"}
# Settings the two networks were trained with (from the configs of Music-Source-Separation-Training)
ROFORMER_ARGS = dict(dim=384, depth=6, stereo=True, num_stems=1, time_transformer_depth=1, freq_transformer_depth=1,
                     num_bands=60, dim_head=64, heads=8, attn_dropout=0, ff_dropout=0, flash_attn=True,
                     dim_freqs_in=1025, sample_rate=44100, stft_n_fft=2048, stft_hop_length=441,
                     stft_win_length=2048, stft_normalized=False, mask_estimator_depth=2)
BANDIT_ARGS = dict(in_channels=1, stems=["speech", "music", "sfx"], band_type="musical", n_bands=64,
                   normalize_channel_independently=False, treat_channel_as_feature=True, n_sqm_modules=8,
                   emb_dim=128, rnn_dim=256, bidirectional=True, rnn_type="GRU", mlp_dim=512,
                   hidden_activation="Tanh", hidden_activation_kwargs=None, complex_mask=True, use_freq_weights=True,
                   n_fft=2048, win_length=2048, hop_length=512, window_fn="hann_window", wkwargs=None, power=None,
                   center=True, normalized=True, pad_mode="reflect", onesided=True)

NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
# Model files: shipped with the app (installed copy: inside the app folder), or in the data folder on this PC
MODELS_DIR = os.path.join(getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__))), "models")
DATA_MODELS_DIR = os.path.join(os.environ.get("NAQI_DATA") or os.path.join(os.path.expanduser("~"), "Naqi-data"),
                               "models")
_cache = {}
_load_lock = threading.Lock()


class Cancelled(Exception):
    pass


def duration_of(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                         capture_output=True, text=True, stdin=subprocess.DEVNULL,
                         creationflags=NOWIN).stdout.strip()
    return float(out) if out else 0.0


def _video_stream(path):
    """(codec, height) of the file's real video (a cover image does not count), or (None, 0) for audio-only files."""
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries",
                          "stream=codec_name,height:stream_disposition=attached_pic", "-of", "csv=p=0", path],
                         capture_output=True, text=True, stdin=subprocess.DEVNULL, creationflags=NOWIN).stdout
    for line in out.splitlines():
        codec, height, cover = (line.split(",") + ["", ""])[:3]
        if cover.strip() != "1":
            return codec.strip(), int(height) if height.strip().isdigit() else 0
    return None, 0


def video_codec(path):
    """Codec of the file's real video (a cover image does not count), or None for audio-only files."""
    return _video_stream(path)[0]


def _video_args(src, height):
    """ffmpeg video options for an MP4 result. The picture is copied untouched when MP4 can hold it and it is
    not taller than `height` (None = keep the original size); otherwise it is (re-)encoded to H.264."""
    codec, h = _video_stream(src)
    shrink = bool(height) and h > height
    if codec in MP4_VIDEO and not shrink:
        return ["-c:v", "copy"]
    args = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
    if shrink:
        args += ["-vf", f"scale=-2:'min({height},ih)'"]   # -2 keeps the width even; never made bigger
    return args


def device_name():
    """Name of the graphics card that will be used, or None when it will run on the CPU."""
    return torch.cuda.get_device_name(0) if torch.cuda.is_available() else None


def _model_file(name):
    for folder in (MODELS_DIR, DATA_MODELS_DIR):
        path = os.path.join(folder, name)
        if os.path.exists(path):
            return path
    raise RuntimeError(f"Model file {name} not found in {MODELS_DIR} or {DATA_MODELS_DIR}.")


def _load_separators():
    from separators.bandit_v2.bandit import Bandit
    from separators.mel_band_roformer import MelBandRoformer
    voice = MelBandRoformer(**ROFORMER_ARGS)
    voice.load_state_dict(torch.load(_model_file(MODEL_FILES["voice"]), map_location="cpu"))
    effects = Bandit(fs=BANDIT_SR, **BANDIT_ARGS)
    state = torch.load(_model_file(MODEL_FILES["effects"]), map_location="cpu", weights_only=False)["state_dict"]
    effects.load_state_dict({k[len("model."):]: v for k, v in state.items() if k.startswith("model.")})
    for stem in ("speech", "music"):   # only Bandit's "effects" output is used
        del effects.mask_estim[stem]
    return voice.eval(), effects.eval()


def _models():
    with _load_lock:
        if "voice" not in _cache:
            _cache["voice"], _cache["effects"] = _load_separators()
    return _cache["voice"], _cache["effects"]


def warm_up():
    """Load the models now (takes a few seconds) so the first file starts right away."""
    _models()


def _read_frames(stream, n):
    """Read up to n stereo float32 frames from the ffmpeg pipe."""
    want = n * 8
    chunks = []
    while want:
        b = stream.read(want)
        if not b:
            break
        chunks.append(b)
        want -= len(b)
    data = b"".join(chunks)
    return np.frombuffer(data[:len(data) // 8 * 8], dtype=np.float32).reshape(-1, 2)


def _blocks(path, block_s, cancel, start_s=0.0):
    """The sound of any audio/video file from start_s on, block by block: yields (mix, lead, n). mix is (n_all, 2)
    float32 with up to MARGIN_S of the neighbouring audio on each side; the block itself is mix[lead:lead + n]."""
    dec = subprocess.Popen(["ffmpeg", "-v", "error", "-ss", f"{start_s:.3f}", "-i", path, "-vn", "-f", "f32le",
                            "-ac", "2", "-ar", str(SR), "pipe:1"],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                           creationflags=NOWIN)
    block, margin = block_s * SR, MARGIN_S * SR
    left = np.zeros((0, 2), np.float32)
    try:
        buf = _read_frames(dec.stdout, block + margin)
        if not len(buf):
            raise RuntimeError("Could not read any audio from the file.")
        while len(buf):
            if cancel():
                raise Cancelled()
            core = buf[:block]
            yield np.concatenate([left, buf[:block + margin]]), len(left), len(core)
            left = core[-margin:]
            buf = np.concatenate([buf[block:], _read_frames(dec.stdout, block)])
    finally:
        dec.kill()
        dec.wait()


def _pieces(fn, x, piece, join, batch, tick):
    """Run fn on overlapping pieces of x (2, n) and cross-fade them. fn: (b, 2, piece) -> (b, 2, piece).
    join = samples two neighbouring pieces share. tick(done 0..1) is called after every batch."""
    hop = piece - join
    n = x.shape[-1]
    x = F.pad(x, (join, join + (-(n + join)) % hop))
    ramp = torch.hann_window(2 * join, periodic=True, device=x.device)
    win = torch.ones(piece, device=x.device)   # flat middle, ramps that add up to a constant 1 where pieces overlap
    win[:join], win[-join:] = ramp[:join], ramp[join:]
    out = torch.zeros_like(x)
    starts = list(range(0, x.shape[-1] - piece + 1, hop))
    for i in range(0, len(starts), batch):
        part = starts[i:i + batch]
        with torch.no_grad():
            y = fn(torch.stack([x[:, s:s + piece] for s in part])).float()
        for s, yy in zip(part, y):
            out[:, s:s + piece] += yy * win
        tick(min(1.0, (i + batch) / len(starts)))
    return out[:, join:join + n]


def separate(x, device, tick=lambda frac: None):
    """x: (2, n) mix on `device` -> (voice, effects), both (2, n). The music is what is in neither.
    tick(done 0..1) is called often; it may raise Cancelled."""
    voice_net, effects_net = _models()
    voice_net.to(device), effects_net.to(device)
    half = device == "cuda"   # half precision on the GPU: about twice as fast

    def voice_fn(b):
        with torch.autocast("cuda", dtype=torch.float16, enabled=half):
            return voice_net(b)

    def effects_fn(b):
        """One pass: Bandit listens to left+right mixed together, and its "this is an effect" mask is then put
        on the left and the right channel each (normal use runs the whole model once per channel)."""
        net, n = effects_net, b.shape[-1]
        with torch.autocast("cuda", dtype=torch.float16, enabled=half):
            mono = net.stft(b.mean(1, keepdim=True))                    # (b, 1, freq, time)
            m = net.mask_estim["sfx"](net.tf_model(net.band_split(mono))).to(mono.dtype)
            lr = net.stft(b.reshape(-1, 1, n))                          # (2b, 1, freq, time)
            s = torch.reshape(lr * m.repeat_interleave(2, 0), lr.shape)
            return net.istft(s, n).reshape(b.shape)

    n = x.shape[-1]
    voice = _pieces(voice_fn, x, PIECE_S * SR, JOIN_S * SR, 1, lambda f: tick(0.6 * f))
    rest = resample(x - voice, SR, BANDIT_SR)
    effects = _pieces(effects_fn, rest, PIECE_S * BANDIT_SR, JOIN_S * BANDIT_SR, 2, lambda f: tick(0.6 + 0.4 * f))
    del rest
    return voice, resample(effects, BANDIT_SR, SR)[:, :n]


def _level_db(x):
    """Loudness (dB) of x (2, n) around every TRACE_HOP samples."""
    p = x.pow(2).mean(0)[None, None]
    p = F.avg_pool1d(p, TRACE_WINDOW, TRACE_HOP, padding=TRACE_WINDOW // 2, count_include_pad=False)
    return 10 * torch.log10(p[0, 0] + 1e-12)


def trace_check(x, kept):
    """The music-trace decision for the mix x and what was kept of it (both (2, n)), per 10 ms:
    (keep, music_db, kept_db). keep = 1.0 where the kept sound stays, 0.0 where it is muted."""
    music_db, kept_db = _level_db(x - kept), _level_db(kept)
    keep = ~((music_db > TRACE_FLOOR_DB) & (kept_db - music_db < TRACE_MARGIN_DB))
    k = keep.float()[None, None]
    n = k.shape[-1]
    k = F.max_pool1d(k, TRACE_BRIDGE, 1, padding=TRACE_BRIDGE // 2)[..., :n]
    k = -F.max_pool1d(-k, TRACE_BRIDGE, 1, padding=TRACE_BRIDGE // 2)[..., :n]
    return k[0, 0], music_db, kept_db


def _gain(keep, n):
    """Keep/mute per 10 ms -> gain per sample, with short fades."""
    k = F.avg_pool1d(keep[None, None], 2 * round(FADE_S * SR / TRACE_HOP / 2) + 1, 1,
                     padding=round(FADE_S * SR / TRACE_HOP / 2), count_include_pad=False)
    return F.interpolate(k, size=k.shape[-1] * TRACE_HOP, mode="linear", align_corners=False)[0, 0, :n]


def mute_traces(x, kept):
    """kept with the moments muted where a rest of the music could be heard -> (result (2, n), keep per 10 ms)."""
    keep = trace_check(x, kept)[0]
    return kept * _gain(keep, x.shape[-1]), keep


def remove_music(x, device, tick=lambda frac: None):
    """x: (2, n) mix on `device` -> (the mix without music (2, n), muted). muted: per 10 ms, 1.0 where the
    music-trace check muted the sound."""
    voice, effects = separate(x, device, tick)
    out, keep = mute_traces(x, voice + effects)
    return out, 1.0 - keep


def _separate(path, raw, total_s, progress, cancel):
    """Pass 1: write the file's sound without music to `raw` (s16 stereo). Returns (device, seconds muted)."""
    device = "cuda" if torch.cuda.is_available() else "cpu"
    done, muted_s = 0, 0.0

    def tick(frac):
        if cancel():
            raise Cancelled()
        if total_s:
            progress(min((done + frac * n) / SR / total_s, 1.0))

    for mix, lead, n in _blocks(path, BLOCK_S, cancel):
        x = torch.from_numpy(mix.T.copy())
        try:
            out, muted = remove_music(x.to(device), device, tick)
        except RuntimeError:
            # GPU full, too old or its driver failed: finish on the CPU instead of failing
            if device == "cpu":
                raise
            torch.cuda.empty_cache()
            device = "cpu"
            out, muted = remove_music(x, device, tick)
        muted_s += float(muted[lead // TRACE_HOP:(lead + n) // TRACE_HOP].sum()) * TRACE_HOP / SR
        raw.write((out[:, lead:lead + n].T.clamp(-1, 1) * 32767).short().cpu().numpy().tobytes())
        del out, muted, x
        done += n
    return device, muted_s


def parse_time(text):
    """'83.5', '1:23.5' or '1:01:23' -> seconds."""
    s = 0.0
    for piece in str(text).split(":"):
        s = s * 60 + float(piece)
    return s


def explain(path, at_s, window_s=5.0):
    """Text table of the music-trace check around `at_s` seconds: how loud the removed music and the kept sound
    are, and whether the moment was kept or muted. Used to understand a slip."""
    start = max(0.0, at_s - window_s - 10)   # the models hear some audio before and after the moment
    device = "cuda" if torch.cuda.is_available() else "cpu"
    mix = next(_blocks(path, int(2 * (window_s + 10)), lambda: False, start))[0]
    x = torch.from_numpy(mix.T.copy()).to(device)
    voice, effects = separate(x, device)
    keep, music_db, kept_db = (v.cpu().numpy() for v in trace_check(x, voice + effects))
    step = 10   # one row per 100 ms
    lines = [f"{os.path.basename(path)} around {at_s:.1f} s; one row per {step * TRACE_HOP * 1000 // SR} ms, levels "
             f"in dB. Muted when the removed music is above {TRACE_FLOOR_DB:.0f} dB and the kept sound is not "
             f"louder than the music {TRACE_MARGIN_DB:+.0f} dB (short gaps inside kept sound stay).",
             "    time  music   kept  result"]
    for i in range(0, len(music_db), step):
        t = start + i * TRACE_HOP / SR
        if abs(t - at_s) <= window_s:
            mark = ">" if abs(t - at_s) < step * TRACE_HOP / SR / 2 else " "
            lines.append(f"{mark}{t:7.1f}  {music_db[i]:5.0f}  {kept_db[i]:5.0f}  {'KEPT' if keep[i] else 'muted'}")
    return "\n".join(lines)


def _encode(path, raw_path, kbps, cancel, src, vargs, progress, skip=0, tags=None):
    """Pass 2: write the cleaned audio into `path` (picture and tags come from `src`; None = sound only).
    vargs: ffmpeg video options for an MP4 (None for MP3). progress(0..1) follows the audio fed to ffmpeg.
    skip: bytes before the sound in `raw_path` (a WAV header); tags: more tags to write, e.g. {"title": ...}."""
    base, ext = os.path.splitext(path)
    tmp = base + ".speech" + ext
    total = max(1, os.path.getsize(raw_path) - skip)
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "s16le", "-ar", str(SR), "-ac", "2", "-i", "pipe:0"]
    if src:
        cmd += ["-i", src, "-map_metadata", "1"]
    cmd += ["-map", "0:a"]
    for key, value in (tags or {}).items():
        cmd += ["-metadata", f"{key}={value}"]
    if vargs is None:
        if src and not video_codec(src):   # keep a cover image, but never put a real video into an MP3
            cmd += ["-map", "1:v?", "-c:v", "copy", "-disposition:v", "attached_pic"]
        cmd += ["-c:a", "libmp3lame", "-b:a", f"{kbps}k", "-id3v2_version", "3"]
    else:
        # Capital V = real video only, no cover images
        cmd += ["-map", "1:V?"] + vargs + ["-c:a", "aac", "-b:a", f"{kbps}k", "-movflags", "+faststart"]
    with tempfile.TemporaryFile() as err:
        enc = subprocess.Popen(cmd + [tmp], stdin=subprocess.PIPE, stderr=err, creationflags=NOWIN)
        try:
            with open(raw_path, "rb") as raw:
                raw.seek(skip)
                pos = 0
                while True:
                    if cancel():
                        raise Cancelled()
                    pcm = raw.read(SR * 4 * 10)
                    if not pcm:
                        break
                    try:
                        enc.stdin.write(pcm)
                    except OSError:   # ffmpeg stopped early: its own message below says why
                        break
                    pos += len(pcm)
                    progress(pos / total)
            try:
                enc.stdin.close()
            except OSError:
                pass
            ok = enc.wait() == 0
        except BaseException:
            enc.kill()
            enc.wait()
            if os.path.exists(tmp):
                os.remove(tmp)
            raise
        if not ok:
            err.seek(0)
            msg = err.read().decode("utf-8", "replace").strip()
            if os.path.exists(tmp):
                os.remove(tmp)
            raise RuntimeError("ffmpeg could not write the cleaned audio: " + msg[-300:])
    os.replace(tmp, path)


def clean_file(path, kbps=192, progress=lambda frac: None, cancel=lambda: False, src=None, height=None):
    """Replace the audio of `path` (mp3 or mp4) with the same sound without music. Returns measured numbers.
    With `src` (any audio/video file), the sound is read from `src` and the result is written to `path`;
    `src` itself is not changed. height: for an MP4, shrink a taller video to this many lines (None = keep)."""
    src = src or path
    vargs = None if os.path.splitext(path)[1].lower() == ".mp3" else _video_args(src, height)
    # Re-encoding the picture takes a real share of the time, so the progress bar gives it room
    split = 0.93 if vargs is None or vargs[1] == "copy" else 0.6
    t0 = time.perf_counter()
    total_s = duration_of(src)
    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()
    fd, raw_path = tempfile.mkstemp(suffix=".pcm")
    try:
        with os.fdopen(fd, "wb") as raw:
            device, muted_s = _separate(src, raw, total_s, lambda f: progress(f * split), cancel)
        t1 = time.perf_counter()
        _encode(path, raw_path, kbps, cancel, src, vargs, lambda f: progress(split + f * (0.99 - split)))
        progress(1.0)
    finally:
        if os.path.exists(raw_path):
            os.remove(raw_path)
    seconds = time.perf_counter() - t0
    return {
        "duration_s": total_s,
        "seconds": seconds,
        "separation_s": t1 - t0,
        "speed_x": total_s / seconds if seconds else 0.0,
        "device": device,
        "peak_vram_mb": torch.cuda.max_memory_reserved() / 2**20 if device == "cuda" else 0.0,
        "muted_fraction": muted_s / total_s if total_s else 0.0,
    }


def save_wav(path, wav, kbps=192, progress=lambda frac: None, cancel=lambda: False, src=None, height=None,
             tags=None):
    """Save the cleaned sound of "Clean and play" (the WAV cache, SPEC R14d) as `path` (MP3 or MP4) without cleaning
    again. src: the file the picture (MP4), cover and tags come from (None = sound only); height: for an MP4, shrink
    a taller picture to this many lines (None = keep); tags: more tags to write."""
    mp4 = os.path.splitext(path)[1].lower() == ".mp4"
    if mp4 and not (src and video_codec(src)):
        raise ValueError("There is no picture to save. Save it as MP3.")
    _encode(path, wav, kbps, cancel, src, _video_args(src, height) if mp4 else None, progress, skip=44, tags=tags)
    progress(1.0)


# ---------- play while cleaning (SPEC R14a-c) ----------

def chunk_plan(n):
    """Planned cuts (samples, inside the sound) for a sound of n samples: chunks of CHUNKS_S, a short last piece
    merged into the one before. One rule for every length (a 19 min video = 2 + 5 + 5 + 7 min)."""
    ends, pos, i = [], 0, 0
    while pos < n:
        pos += CHUNKS_S[min(i, len(CHUNKS_S) - 1)] * SR
        ends.append(min(pos, n))
        i += 1
    if len(ends) > 1 and ends[-1] - ends[-2] < MIN_LAST_S * SR:
        ends.pop(-2)
    return ends[:-1]


def keeps_ahead(ready_s, ends_s, speed):
    """Can playback start from the beginning now (the first ready_s seconds are clean) without ever catching up
    with the cleaning? ends_s: planned ends of the chunks still to clean (the last one = the end of the sound);
    speed: measured cleaning speed (x realtime). When not, the whole sound is cleaned first (SPEC R14c)."""
    start, wait = ready_s, 0.0
    for end in ends_s:
        wait += (end - start) * PLAY_SLACK / speed if speed > 0 else float("inf")   # until this chunk is clean
        if wait > start - PLAY_LEAD_S:   # playback reaches this chunk's start after `start` seconds
            return False
        start = end
    return True


class _Sound:
    """A file's sound, decoded once from start to end. Only the part from `at` on is kept in memory, so the parts
    near the cleaning can be read again (block margins, the cut search) without decoding twice."""
    def __init__(self, path):
        self.dec = subprocess.Popen(["ffmpeg", "-v", "error", "-i", path, "-vn", "-f", "f32le", "-ac", "2",
                                     "-ar", str(SR), "pipe:1"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    stdin=subprocess.DEVNULL, creationflags=NOWIN)
        self.buf = np.zeros((0, 2), np.float32)
        self.at = 0          # sample number of buf[0]
        self.eof = False

    @property
    def end(self):
        return self.at + len(self.buf)

    def fill(self, upto):
        """Decode on until sample `upto` (or the end of the sound)."""
        if not self.eof and self.end < upto:
            more = _read_frames(self.dec.stdout, upto - self.end)
            self.eof = len(more) < upto - self.end
            self.buf = np.concatenate([self.buf, more])
            if not self.end:
                raise RuntimeError("Could not read any audio from the file.")

    def get(self, a, b):
        self.fill(b)
        return self.buf[a - self.at:b - self.at]

    def forget(self, before):
        if before > self.at:
            self.buf = self.buf[before - self.at:].copy()
            self.at = before

    def close(self):
        self.dec.kill()
        self.dec.wait()


def _quietest(sound, t, lo):
    """Sample number of the quietest 200 ms of the mix within CUT_SEARCH_S of sample t, at least 1 s after sample
    lo and 1 s before the end of the sound. None when the sound ends before that (no cut needed)."""
    sound.fill(t + (CUT_SEARCH_S + 1) * SR)
    a, b = max(lo + SR, t - CUT_SEARCH_S * SR), min(sound.end - SR, t + CUT_SEARCH_S * SR)
    if b <= a:
        return None
    db = _level_db(torch.from_numpy(sound.get(a, b).T.copy()))
    return a + int(db.argmin()) * TRACE_HOP


def _wav_header(frames):
    """44-byte header of a 16-bit stereo WAV file with `frames` samples per channel."""
    data = min(frames * 4, 0xFFFFFFFF - 36)
    return struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + data, b"WAVE", b"fmt ", 16, 1, 2, SR, SR * 4, 4, 16,
                       b"data", data)


def clean_to_wav(src, wav, progress=lambda frac: None, cancel=lambda: False, ready=lambda seconds, plays: None):
    """Clean the sound of `src` (any audio/video file) into the WAV file `wav`, chunk by chunk (SPEC R14a), so it
    can be played while it is cleaned. The file has its full length from the start (silence where nothing is clean
    yet), so a player sees the whole duration. Each chunk is cleaned like clean_file does (BLOCK_S blocks with
    MARGIN_S of the neighbouring audio, read from outside the chunk too), cut at the quietest moment near its
    planned end and cross-faded into the next one over XFADE_S.
    After each chunk: ready(seconds clean from the start, plays); plays = playback can start now and stay ahead
    of the cleaning (always true once all is clean). Returns measured numbers (like clean_file)."""
    t0 = time.perf_counter()
    total_s = duration_of(src)
    n_est = round(total_s * SR)
    planned = chunk_plan(n_est)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()
    h = round(XFADE_S * SR / 2)
    block, margin = BLOCK_S * SR, MARGIN_S * SR
    sound = _Sound(src)
    out = open(wav, "wb")
    written, pending, muted_s, plays, first_s = 0, None, 0.0, False, 0.0

    def put(y, hold):
        """Append y (n, 2) float32 to the file; the first samples are cross-faded with the end held back from
        the chunk before. hold: keep the last 2h samples back for the next chunk."""
        nonlocal written, pending
        if pending is not None:
            w = np.linspace(0, 1, len(pending), dtype=np.float32)[:, None]
            y[:len(pending)] = pending * (1 - w) + y[:len(pending)] * w
            pending = None
        if hold:
            y, pending = y[:-2 * h], y[-2 * h:].copy()
        out.write((np.clip(y, -1, 1) * 32767).astype("<i2").tobytes())
        out.flush()   # a player may be reading the file right now
        written += len(y)

    try:
        out.write(_wav_header(n_est))
        out.truncate(44 + n_est * 4)
        t_clean = time.perf_counter()
        a = 0
        for i in range(len(planned) + 1):
            last, b = i == len(planned), None
            s = max(0, a - h)   # every chunk starts and ends h early/late, for the crossfade
            while True:
                if cancel():
                    raise Cancelled()
                # The cut is found once the block that may hold it is next
                if not last and b is None and s + block + margin + h >= planned[i] - CUT_SEARCH_S * SR:
                    b = _quietest(sound, planned[i], a)
                    last = b is None   # the sound ended before this cut
                stop = None if b is None else b + h   # None: the end of the sound, or a cut still far ahead
                e = s + block if stop is None else min(s + block, stop)
                sound.fill(e + margin)
                e = min(e, sound.end)
                lo, hi = max(0, s - margin), min(e + margin, sound.end)
                x = torch.from_numpy(sound.get(lo, hi).T.copy())

                def tick(frac, s=s, e=e):
                    if cancel():
                        raise Cancelled()
                    if n_est:
                        progress(min((s + frac * (e - s)) / n_est, 1.0))

                try:
                    y, muted = remove_music(x.to(device), device, tick)
                except RuntimeError:
                    # GPU full, too old or its driver failed: finish on the CPU instead of failing
                    if device == "cpu":
                        raise
                    torch.cuda.empty_cache()
                    device = "cpu"
                    y, muted = remove_music(x, device, tick)
                muted_s += float(muted[(s - lo) // TRACE_HOP:(e - lo) // TRACE_HOP].sum()) * TRACE_HOP / SR
                chunk_done = e == stop or (last and sound.eof and e >= sound.end)
                put(y[:, s - lo:e - lo].T.cpu().numpy(), hold=chunk_done and not last)
                del x, y, muted
                sound.forget(e - 2 * h - margin)   # the next block (or chunk) reads from here on
                if chunk_done:
                    break
                s = e
            first_s = first_s or time.perf_counter() - t0
            speed = written / SR / (time.perf_counter() - t_clean)
            plays = plays or last or keeps_ahead(written / SR, [p / SR for p in planned[i + 1:]] + [total_s], speed)
            if last:
                break
            ready(written / SR, plays)
            a = b
        out.truncate(44 + written * 4)   # the exact length (the duration read before can be a little off)
        out.seek(0)
        out.write(_wav_header(written))
        out.close()
        ready(written / SR, True)
    finally:
        out.close()
        sound.close()
    seconds = time.perf_counter() - t0
    return {
        "duration_s": written / SR,
        "seconds": seconds,
        "first_chunk_s": first_s,
        "speed_x": written / SR / seconds if seconds else 0.0,
        "device": device,
        "peak_vram_mb": torch.cuda.max_memory_reserved() / 2**20 if device == "cuda" else 0.0,
        "muted_fraction": muted_s * SR / written if written else 0.0,
    }


# ---------- old "talking only" method (Demucs voice + Silero VAD), used by benchmark.py and candidates.py ----------

VAD_SR = 16000        # Silero VAD sample rate
VAD_FRAME = 512       # Silero gives one speech score per 512 samples (32 ms)
OLD_BLOCK_S = 60      # Demucs block length
OVERLAP = 0.25        # Demucs overlap between its internal segments
VAD_THRESHOLD = 0.5
VAD_MIN_SILENCE_MS = 400   # shorter pauses inside speech are kept
VAD_PAD_MS = 150           # kept around each speech part so word starts/ends are not clipped


def _load_demucs():
    import yaml
    from demucs.apply import BagOfModels
    from demucs.hf import load_safetensors_model
    from demucs.pretrained import get_model
    bag_file = os.path.join(MODELS_DIR, "htdemucs.yaml")
    if not os.path.exists(bag_file):
        return get_model("htdemucs")   # no local copy: Demucs downloads it once
    with open(bag_file) as f:
        bag = yaml.safe_load(f)
    models = [load_safetensors_model(os.path.join(MODELS_DIR, sig + ".safetensors")) for sig in bag["models"]]
    return BagOfModels(models, bag.get("weights"), bag.get("segment"))


def old_models():
    """(Demucs, Silero VAD), loaded on first use."""
    from silero_vad import load_silero_vad
    with _load_lock:
        if "demucs" not in _cache:
            vad = load_silero_vad(sequence=True)   # whole-file mode: much faster than frame by frame
            _cache["demucs"], _cache["vad"] = _load_demucs().eval(), vad
    return _cache["demucs"], _cache["vad"]


def _vocals(model, x, device):
    """x: (2, n) tensor -> vocals (2, n). Same normalisation Demucs itself uses."""
    from demucs.apply import apply_model
    ref = x.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    with torch.no_grad():
        out = apply_model(model, ((x - mean) / std)[None], device=device, shifts=0, split=True,
                          overlap=OVERLAP, progress=False)[0, model.sources.index("vocals")]
    return out * std + mean


def vocals16(path, progress=lambda frac: None, cancel=lambda: False):
    """The Demucs vocals of any audio/video file as 16 kHz mono (what the VAD hears)."""
    model, _ = old_models()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(device)
    total_s = duration_of(path)
    mono16, done = [], 0
    for mix, lead, n in _blocks(path, OLD_BLOCK_S, cancel):
        voc = _vocals(model, torch.from_numpy(mix.T.copy()).to(device), device)[:, lead:lead + n]
        mono16.append(resample(voc.mean(0), SR, VAD_SR).cpu())
        done += n
        if total_s:
            progress(min(done / SR / total_s, 1.0))
    return torch.cat(mono16)


def vad_probs(wav16):
    """Silero's speech score (0..1) for every VAD_FRAME samples of the 16 kHz vocals."""
    _, vad = old_models()
    return vad.audio_forward(wav16.numpy() if hasattr(wav16, "numpy") else wav16, sampling_rate=VAD_SR)


def parts_from_probs(probs, n_samples, threshold=None, min_silence_ms=None, pad_ms=None):
    """Speech scores -> [(start_s, end_s), ...] with the old app's settings (or the given ones, for tuning)."""
    from silero_vad.utils_vad import get_speech_timestamps_from_probs
    stamps = get_speech_timestamps_from_probs(
        probs, sampling_rate=VAD_SR, audio_length_samples=n_samples,
        threshold=VAD_THRESHOLD if threshold is None else threshold,
        min_silence_duration_ms=VAD_MIN_SILENCE_MS if min_silence_ms is None else min_silence_ms,
        speech_pad_ms=VAD_PAD_MS if pad_ms is None else pad_ms)
    parts = []
    for s in stamps:
        a, b = s["start"] / VAD_SR, s["end"] / VAD_SR
        if parts and a - parts[-1][1] <= 3 * FADE_S:   # too close to fade out and back in: join them
            parts[-1][1] = b
        else:
            parts.append([a, b])
    return parts


def old_explain(path, at_s, window_s=5.0, wav16=None):
    """Text table of the VAD score around `at_s` seconds, and whether the old method keeps or mutes each moment."""
    wav16 = vocals16(path) if wav16 is None else wav16
    probs = vad_probs(wav16)
    parts = parts_from_probs(probs, len(wav16))
    step = VAD_FRAME / VAD_SR
    lines = [f"{os.path.basename(path)} around {at_s:.1f} s (threshold {VAD_THRESHOLD}, "
             f"min silence {VAD_MIN_SILENCE_MS} ms, pad {VAD_PAD_MS} ms); one row per {step * 1000:.0f} ms",
             "  time   score  result"]
    first, last = max(0, int((at_s - window_s) / step)), min(len(probs), int((at_s + window_s) / step) + 1)
    for i in range(first, last):
        t = i * step
        kept = any(a <= t + step / 2 <= b for a, b in parts)
        bar = "#" * round(float(probs[i]) * 20)
        lines.append(f"{t:7.2f}  {probs[i]:.2f}  {'KEPT ' if kept else 'muted'} "
                     f"{'>' if abs(t - at_s) < step / 2 else '|'}{bar}")
    return "\n".join(lines)
