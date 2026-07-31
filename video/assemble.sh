#!/bin/bash
# Assemble a long-form video from individually-rendered, individually-approved
# act segments.
#
#   assemble.sh <out.mp4> <act1-voice.mp4> <act2-voice.mp4> [...]
#
# Inputs are VOICE-MUXED segments (scene render + narration, NO music). The
# music bed is generated once for the assembled length and laid over the whole
# piece; mixing per act would restart the bed at every join and make each seam
# audible. Same mix discipline as produce_video.sh: measured static gains only
# (voice to -16.5 LUFS capped by true-peak headroom, bed 20 LU under), no
# loudnorm, no limiter — nothing that can pump or lift the noise floor between
# sentences.
#
# The CTA outro is NOT added here: bolt_cta.sh remains the single closer, run
# on the assembled output when the piece is final.
#
# Environment (all optional): VOX_DIR, VOX_PY as in produce_video.sh.
set -euo pipefail

VIDEO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VOX_DIR="${VOX_DIR:-$HOME/Documents/code/VoxCPM}"
VOX_PY="${VOX_PY:-$VOX_DIR/.venv/bin/python}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

OUT="$1"
shift
[ $# -ge 2 ] || { echo "need at least 2 segments"; exit 1; }

# 1. concat with normalized params (same recipe bolt_cta.sh uses; act renders
#    may differ in fps or pixel format, and concat is silently wrong otherwise).
#    CRITICAL: aformat pins sample_fmts=fltp on every audio leg. An unpinned
#    leg (anullsrc especially) can negotiate u8 and concat then converts the
#    WHOLE program to 8-bit audio (~-59 dBFS quantization hiss — the shipped
#    "static" defect, 2026-07-31).
FC=""
MAPS=""
i=0
INPUTS=()
for f in "$@"; do
  [ -f "$f" ] || { echo "missing segment: $f"; exit 1; }
  INPUTS+=("-i" "$f")
  FC="${FC}[$i:v]fps=60,scale=1920:1080,setsar=1,format=yuv420p[v$i];"
  FC="${FC}[$i:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a$i];"
  MAPS="${MAPS}[v$i][a$i]"
  i=$((i + 1))
done
FC="${FC}${MAPS}concat=n=$i:v=1:a=1[v][a]"
ffmpeg -v error -y "${INPUTS[@]}" -filter_complex "$FC" \
  -map "[v]" -map "[a]" -c:v libx264 -crf 20 -preset medium -pix_fmt yuv420p \
  -c:a aac -b:a 256k -movflags +faststart "$TMP/assemble_voice.mp4"

DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$TMP/assemble_voice.mp4")
echo "  concatenated $i segments -> ${DUR%.*}s"

# 2. one continuous music bed for the whole piece
"$VOX_PY" "$VIDEO_DIR/gen_music.py" "$DUR" "$TMP/assemble_music.wav" >/dev/null

# 3. mix: measured static gains — voice to -16.5 LUFS capped by true-peak
#    headroom to -1.5 dBTP (VoxCPM takes are high-crest, so the peak cap
#    usually governs); bed measured THROUGH its lowpass and set 20 LU under
#    the actual voice level.
read -r VOICE_I VOICE_TP <<<"$(ffmpeg -hide_banner -nostdin -i "$TMP/assemble_voice.mp4" \
  -af ebur128=peak=true -f null - 2>&1 | tail -20 | awk '$1=="I:"{i=$2} $1=="Peak:"{p=$2} END{print i, p}')"
BED_I=$(ffmpeg -hide_banner -nostdin -i "$TMP/assemble_music.wav" -af "lowpass=f=3500,ebur128" \
  -f null - 2>&1 | tail -20 | awk '$1=="I:"{i=$2} END{print i}')
read -r VGAIN BGAIN VOUT <<<"$(python3 -c "
vi, vtp, bi = $VOICE_I, $VOICE_TP, $BED_I
g = min(-16.5 - vi, -1.5 - vtp)   # loudness target, capped by true-peak headroom
print(round(g, 2), round((vi + g - 20.0) - bi, 2), round(vi + g, 2))")"
echo "  static gains: voice ${VGAIN}dB (I=${VOICE_I} TP=${VOICE_TP} -> ~${VOUT} LUFS), bed ${BGAIN}dB (20 LU under)"
ffmpeg -v error -y -i "$TMP/assemble_voice.mp4" -i "$TMP/assemble_music.wav" -filter_complex \
  "[0:a]volume=${VGAIN}dB,asplit=2[v][k];[1:a]volume=${BGAIN}dB,lowpass=f=3500[m];\
   [m][k]sidechaincompress=threshold=0.03:ratio=4:attack=20:release=320[d];\
   [v][d]amix=inputs=2:normalize=0:duration=first[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 256k "$OUT"
echo "  assembled: $OUT ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" | cut -d. -f1)s)"
