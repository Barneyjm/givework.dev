#!/bin/bash
# Make the branded poster the video's FIRST frame.
#
#   ./set_first_frame.sh <video.mp4> <poster.(jpg|png)> <out.mp4> [trim_seconds]
#
# Social platforms grab frame 1 as the thumbnail, and ours was a plain grabbed
# title card with no branding on it at all. This prepends the poster — the same
# still already used for the share card — so the thumbnail is deliberate.
#
# trim_seconds drops an existing lead-in first (produce_video.sh used to prepend a
# 1s frame-grab), so the poster replaces it rather than stacking on top.
set -euo pipefail
IN="${1:?video}"; POSTER="${2:?poster}"; OUT="${3:?out}"; TRIM="${4:-0}"
HOLD="${HOLD_SECONDS:-0.9}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

read -r W H < <(ffprobe -v error -select_streams v -show_entries stream=width,height -of csv=p=0 "$IN" | tr ',' ' ')
RATE="$(ffprobe -v error -select_streams v -show_entries stream=r_frame_rate -of csv=p=0 "$IN" | head -1)"
FPS="$(python3 -c "n,d='$RATE'.split('/');print(round(float(n)/float(d)))")"

# One filter graph: poster still -> matched size/fps, source trimmed, then concat.
ffmpeg -v error -y -loop 1 -t "$HOLD" -i "$POSTER" -ss "$TRIM" -i "$IN" \
  -f lavfi -t "$HOLD" -i anullsrc=r=48000:cl=stereo \
  -filter_complex "[0:v]scale=${W}:${H},fps=${FPS},setsar=1,format=yuv420p[lead];\
[1:v]fps=${FPS},setsar=1,format=yuv420p[main];\
[2:a]aformat=sample_rates=48000:channel_layouts=stereo[lsil];\
[1:a]aformat=sample_rates=48000:channel_layouts=stereo[ma];\
[lead][lsil][main][ma]concat=n=2:v=1:a=1[v][a]" \
  -map "[v]" -map "[a]" -c:v libx264 -crf 20 -preset medium -pix_fmt yuv420p \
  -c:a aac -b:a 192k -movflags +faststart "$OUT"
echo "$OUT  first frame = $(basename "$POSTER")  ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" | cut -d. -f1)s)"
