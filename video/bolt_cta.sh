#!/bin/bash
# Bolt the shared CTA outro onto a finished video — the single closer.
#
#   bolt_cta.sh <in.mp4> <out-share.mp4> [cta_outro.mp4]
#
# Re-encodes with normalized v/a params so concat is robust across sources.
# Also writes the share deliverable's poster (<slug>-poster.jpg, frame 1,
# -q:v 3) so the pair that ships is produced in one place.
#
# The CTA clip is built once by build_cta_outro.sh and reused across videos;
# pass it as $3 or set CTA_OUTRO (default: cta_outro.mp4 next to this script).
set -euo pipefail

VIDEO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN="$1"
OUT="$2"
CTA="${3:-${CTA_OUTRO:-$VIDEO_DIR/cta_outro.mp4}}"
[ -f "$CTA" ] || { echo "missing CTA outro: $CTA (build it with build_cta_outro.sh)"; exit 1; }

# CRITICAL: aformat pins sample_fmts=fltp on both concat audio legs. An
# unpinned leg can negotiate u8 and concat then converts the WHOLE program to
# 8-bit audio (~-59 dBFS quantization hiss — the shipped "static" defect,
# 2026-07-31).
ffmpeg -v error -y -i "$MAIN" -i "$CTA" -filter_complex \
  "[0:v]fps=60,scale=1920:1080,setsar=1,format=yuv420p[v0];\
   [1:v]fps=60,scale=1920:1080,setsar=1,format=yuv420p[v1];\
   [0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];\
   [1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a1];\
   [v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]" \
  -map "[v]" -map "[a]" -c:v libx264 -crf 20 -preset medium -pix_fmt yuv420p \
  -c:a aac -b:a 192k -movflags +faststart "$OUT"

POSTER="${OUT%.mp4}"
POSTER="${POSTER%-share}-poster.jpg" # <slug>-share.mp4 pairs with <slug>-poster.jpg
ffmpeg -v error -y -i "$OUT" -frames:v 1 -q:v 3 "$POSTER"
echo "bolted: $OUT ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")s) + $POSTER"
