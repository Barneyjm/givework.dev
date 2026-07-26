#!/bin/bash
# Reformat a finished 16:9 conjecture video into a 1080x1920 vertical cut for
# short-form platforms (YouTube Shorts, Reels, TikTok).
#
#   ./make_vertical.sh <slug> [in.mp4] [out.mp4]
#
# The landscape video is composited into a branded 9:16 frame rather than
# re-rendered: the Manim scenes are composed for 16:9, so re-rendering vertically
# would break every layout. The frame carries the conjecture's name above the
# video and the call to action below, where short-form UI chrome and thumbs sit.
#
# Needs: ffmpeg, node (for the frame), and the repo's resvg + fonts.
set -euo pipefail

SLUG="${1:?usage: make_vertical.sh <slug> [in.mp4] [out.mp4]}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IN="${2:-$SLUG-share.mp4}"
OUT="${3:-$SLUG-vertical.mp4}"

[ -f "$IN" ] || { echo "no input video: $IN" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1. Branded backdrop. The script prints its geometry so the overlay maths is
#    defined in exactly one place.
GEO="$(node "$HERE/make_vertical_frame.mjs" "$SLUG" "$TMP/frame.png")"
VIDEO_TOP="$(printf '%s' "$GEO" | sed -n 's/.*"video_top":\([0-9]*\).*/\1/p')"
VIDEO_H="$(printf '%s' "$GEO" | sed -n 's/.*"video_h":\([0-9]*\).*/\1/p')"

# 2. Composite: scale the source to full width and drop it into the well.
#    -shortest ends with the video, not the looped still.
ffmpeg -v error -y \
  -loop 1 -i "$TMP/frame.png" \
  -i "$IN" \
  -filter_complex "[1:v]scale=1080:${VIDEO_H}:flags=lanczos,setsar=1[v];[0:v][v]overlay=0:${VIDEO_TOP}:shortest=1,format=yuv420p[out]" \
  -map "[out]" -map 1:a? \
  -c:v libx264 -crf 20 -preset medium -r 30 \
  -c:a aac -b:a 192k -movflags +faststart \
  "$OUT"

DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" | cut -d. -f1)"
echo "$OUT  (1080x1920, ${DUR}s)"
# Reels caps at 90s; Shorts at 3min; TikTok well beyond. Warn rather than trim,
# since where to cut is an editorial decision.
if [ "${DUR:-0}" -gt 90 ]; then
  echo "  note: ${DUR}s exceeds Instagram Reels' 90s limit (fine for Shorts and TikTok)."
fi
