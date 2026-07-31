#!/bin/bash
# Produce one conjecture explainer end to end from a spec.
#
#   produce_video.sh <spec.json> [quality] [scene.py] [SceneClass]
#
#   quality: l (480p15, default — preview) or h (1080p60 — final)
#   scene:   the Manim scene file; looked up in $WORK first, then in this
#            directory (so the reference scenes here work out of the box)
#
# Output: <slug>-final.mp4 in $WORK. The CTA outro is NOT added here —
# bolt_cta.sh is the single closer, run once the piece is approved.
#
# Environment (all optional):
#   WORK      working dir for narration, renders and outputs   (default: $PWD)
#   VOX_DIR   VoxCPM checkout with gen_spec_narration.py + .venv
#             (default: $HOME/Documents/code/VoxCPM)
#   VOX_PY    python used for narration and the music bed; needs numpy,
#             soundfile, scipy                (default: $VOX_DIR/.venv/bin/python)
#   ENGINE    podman or docker                              (default: podman)
#   MANIM_IMG container image     (default: docker.io/manimcommunity/manim:stable)
#
# AUDIO IS STATIC-GAIN ONLY. The mix applies one measured gain to the voice
# (target -16.5 LUFS, capped by true-peak headroom to -1.5 dBTP) and one to
# the bed (20 LU under the voice), then a lowpass and a sidechain duck. No
# loudnorm, no alimiter — dynamic normalisers pump and lift the noise floor
# between sentences. This shipped as audible static once: an unpinned anullsrc
# concat leg crushed the program to 8-bit (see step 5) and loudnorm amplified
# the hiss in every pause. render_check.mjs's pause-floor gate fails both.
set -euo pipefail

VIDEO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${WORK:-$PWD}"
VOX_DIR="${VOX_DIR:-$HOME/Documents/code/VoxCPM}"
VOX_PY="${VOX_PY:-$VOX_DIR/.venv/bin/python}"
ENGINE="${ENGINE:-podman}"
IMG="${MANIM_IMG:-docker.io/manimcommunity/manim:stable}"

SPEC="$1"
Q="${2:-l}"
SCENE="${3:-conjecture_video.py}"
CLASS="${4:-ConjectureVideo}"
STEM=$(basename "$SCENE" .py)
SLUG=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['slug'])" "$SPEC")
NARR="narration_$SLUG" # relative to $WORK
echo "=== $SLUG (quality=$Q) ==="

mkdir -p "$WORK"
# the spec must live under the container mount
[ -f "$WORK/$(basename "$SPEC")" ] || cp "$SPEC" "$WORK/"

# 1. narration (cloned voice); skipped when durations.json already exists
if [ ! -f "$WORK/$NARR/durations.json" ]; then
  (cd "$VOX_DIR" && "$VOX_PY" gen_spec_narration.py "$WORK/$(basename "$SPEC")" "$WORK/$NARR") \
    2>&1 | grep -vE "modelscope|%\|" | tail -8
fi

# 2. render (silent). The scene may sit in $WORK (a bespoke scene) or in this
#    repo directory (the reference scenes); the repo library is mounted
#    read-only at /kit and put on PYTHONPATH so `from viz import ...` and
#    `from mathviz import ...` resolve either way.
if [ -f "$WORK/$SCENE" ]; then SCENE_PATH="/work/$SCENE"; else SCENE_PATH="/kit/$SCENE"; fi
cd "$WORK"
rm -rf "media/videos/$STEM"
"$ENGINE" run --rm \
  -e SPEC_PATH="/work/$(basename "$SPEC")" -e NARR_DIR="/work/$NARR" \
  -e PYTHONPATH="/kit:/kit/manim" \
  -v "$WORK:/work" -v "$VIDEO_DIR:/kit:ro" -w /work \
  "$IMG" manim -q"$Q" --disable_caching "$SCENE_PATH" "$CLASS" \
  2>&1 | tail -2
QDIR=$([ "$Q" = "h" ] && echo 1080p60 || echo 480p15)
VID="media/videos/$STEM/$QDIR/$CLASS.mp4"
[ -f "$VID" ] || { echo "render did not produce $VID"; exit 1; }

# 3. mux narration at the beat starts the render recorded
python3 - "$NARR" "$VID" "$WORK/${SLUG}-voice.mp4" <<'PY'
import json, subprocess, sys
narr, vid, out = sys.argv[1], sys.argv[2], sys.argv[3]
starts = json.load(open(f"{narr}/starts.json"))
inp, filt, labels = ["-i", vid], [], []
for i, s in enumerate(starts, 1):
    inp += ["-i", f"{narr}/{s['name']}.wav"]
    ms = int(round(s["start"] * 1000))
    filt.append(f"[{i}]adelay={ms}|{ms}[a{i}]"); labels.append(f"[a{i}]")
filt.append("".join(labels) + f"amix=inputs={len(starts)}:normalize=0:dropout_transition=0[a]")
subprocess.run(["ffmpeg","-v","error","-y",*inp,"-filter_complex",";".join(filt),
    "-map","0:v","-map","[a]","-c:v","copy","-c:a","aac","-b:a","192k","-movflags","+faststart",out], check=True)
PY

# 4. one continuous music bed for the whole piece, mixed UNDER the voice with
#    measured static gains (see header). The voice gain targets -16.5 LUFS but
#    is capped by true-peak headroom to -1.5 dBTP — with ~20 LU-crest VoxCPM
#    takes the peak term governs (lands around -21 LUFS), and that is correct:
#    pushing further would need a limiter, and limiters are banned here. The
#    bed is measured THROUGH its lowpass and set 20 LU under the actual voice.
DUR=$(ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$WORK/${SLUG}-voice.mp4")
"$VOX_PY" "$VIDEO_DIR/gen_music.py" "$DUR" "$WORK/music_$SLUG.wav" >/dev/null
read -r VOICE_I VOICE_TP <<<"$(ffmpeg -hide_banner -nostdin -i "$WORK/${SLUG}-voice.mp4" \
  -af ebur128=peak=true -f null - 2>&1 | tail -20 | awk '$1=="I:"{i=$2} $1=="Peak:"{p=$2} END{print i, p}')"
BED_I=$(ffmpeg -hide_banner -nostdin -i "$WORK/music_$SLUG.wav" -af "lowpass=f=3500,ebur128" \
  -f null - 2>&1 | tail -20 | awk '$1=="I:"{i=$2} END{print i}')
read -r VGAIN BGAIN VOUT <<<"$(python3 -c "
vi, vtp, bi = $VOICE_I, $VOICE_TP, $BED_I
g = min(-16.5 - vi, -1.5 - vtp)   # loudness target, capped by true-peak headroom
print(round(g, 2), round((vi + g - 20.0) - bi, 2), round(vi + g, 2))")"
echo "  static gains: voice ${VGAIN}dB (I=${VOICE_I} TP=${VOICE_TP} -> ~${VOUT} LUFS), bed ${BGAIN}dB (20 LU under)"
ffmpeg -v error -y -i "$WORK/${SLUG}-voice.mp4" -i "$WORK/music_$SLUG.wav" -filter_complex \
  "[0:a]volume=${VGAIN}dB,asplit=2[v][k];[1:a]volume=${BGAIN}dB,lowpass=f=3500[m];\
   [m][k]sidechaincompress=threshold=0.03:ratio=4:attack=20:release=320[d];\
   [v][d]amix=inputs=2:normalize=0:duration=first[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k "$WORK/${SLUG}-music.mp4"

# 5. poster title card + 1s lead — final 1080p only (the poster must match the
#    video resolution). For previews, the music cut IS the final.
#    CRITICAL: aformat pins sample_fmts=fltp on BOTH concat audio legs. Without
#    it the anullsrc leg negotiates u8 (enum 0) and concat converts the whole
#    main program to 8-BIT audio (~-59 dBFS quantization hiss — the "static"
#    defect, 2026-07-31). render_check.mjs's pause-floor gate catches it now,
#    but do not remove the pins.
POSTER_T="${POSTER_T:-2.6}" # a settled moment of the title beat
if [ "$Q" = "h" ]; then
  ffmpeg -v error -y -ss "$POSTER_T" -i "$WORK/${SLUG}-music.mp4" -frames:v 1 "$WORK/poster_$SLUG.png"
  ffmpeg -v error -y -loop 1 -t 1.0 -i "$WORK/poster_$SLUG.png" -i "$WORK/${SLUG}-music.mp4" \
    -f lavfi -t 1.0 -i anullsrc=r=48000:cl=stereo \
    -filter_complex "[0:v]scale=1920:1080,fps=60,setsar=1,format=yuv420p[lead];[2:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[sil];[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[main];[lead][sil][1:v][main]concat=n=2:v=1:a=1[v][a]" \
    -map "[v]" -map "[a]" -c:v libx264 -crf 20 -preset medium -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart \
    "$WORK/${SLUG}-final.mp4"
else
  cp "$WORK/${SLUG}-music.mp4" "$WORK/${SLUG}-final.mp4"
fi

echo "=== done: $WORK/${SLUG}-final.mp4 ($(ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$WORK/${SLUG}-final.mp4")s) ==="
