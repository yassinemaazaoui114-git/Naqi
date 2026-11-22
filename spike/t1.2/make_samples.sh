#!/usr/bin/env bash
# T1.2: 30 s test clips in every video codec / container Naqi accepts (from samples/sync_test_5min.mp4, 1080p).
# Run from the project folder: bash spike/t1.2/make_samples.sh  -> samples/codecs/ and samples/codecs_long/
set -e
SRC=samples/sync_test_5min.mp4
OUT=samples/codecs
mkdir -p "$OUT"
V="-ss 60 -t 30 -i $SRC -vf scale=1920:1080 -r 30"
mk() { name=$1; shift; [ -f "$OUT/$name" ] || { echo "== $name"; ffmpeg -v error -y $V "$@" "$OUT/$name"; }; }
mk h264.mp4        -c:v libx264 -preset veryfast -c:a aac
mk h264.mkv        -c:v libx264 -preset veryfast -c:a aac
mk h264_ac3.mkv    -c:v libx264 -preset veryfast -c:a ac3
mk h264.mov        -c:v libx264 -preset veryfast -c:a pcm_s16le
mk h264.m4v        -c:v libx264 -preset veryfast -c:a aac
mk h264.avi        -c:v libx264 -preset veryfast -c:a mp3
mk h264_10bit.mp4  -c:v libx264 -preset veryfast -pix_fmt yuv420p10le -c:a aac
mk hevc.mp4        -c:v libx265 -preset fast -tag:v hvc1 -c:a aac
mk hevc_hev1.mp4   -c:v libx265 -preset fast -c:a aac
mk hevc.mkv        -c:v libx265 -preset fast -c:a aac
mk hevc_10bit.mp4  -c:v libx265 -preset fast -pix_fmt yuv420p10le -tag:v hvc1 -c:a aac
mk av1.mp4         -c:v libsvtav1 -preset 10 -c:a aac
mk av1.mkv         -c:v libsvtav1 -preset 10 -c:a opus -strict -2
mk av1.webm        -c:v libsvtav1 -preset 10 -c:a libopus
mk vp9.webm        -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 3M -c:a libopus
mk vp9.mkv         -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 3M -c:a libopus
mk vp8.webm        -c:v libvpx -deadline realtime -cpu-used 8 -b:v 3M -c:a libvorbis
mk xvid.avi        -c:v mpeg4 -vtag xvid -q:v 4 -c:a mp3
mk divx3.avi       -c:v msmpeg4 -q:v 4 -c:a mp3
mk mpeg2.mkv       -c:v mpeg2video -q:v 4 -c:a mp2
mk mjpeg.avi       -c:v mjpeg -q:v 5 -c:a pcm_s16le
mk wmv2.wmv        -c:v wmv2 -q:v 4 -c:a wmav2
mk prores.mov      -c:v prores_ks -profile:v 0 -c:a pcm_s16le
mk mpeg4.mp4       -c:v mpeg4 -q:v 4 -c:a aac
# 9 min 1080p Xvid for the timing of a long converted copy (test_picture.py)
mkdir -p samples/codecs_long
[ -f samples/codecs_long/xvid_9min.avi ] || ffmpeg -v error -stream_loop 1 -i $SRC -t 540 -vf scale=1920:1080 -r 30   -c:v mpeg4 -vtag xvid -q:v 4 -c:a mp3 samples/codecs_long/xvid_9min.avi
ls -la "$OUT"
