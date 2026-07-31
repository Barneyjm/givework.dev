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
# (to -16.5 LUFS) and one to the bed (20 LU under the voice), then a lowpass
# and a sidechain duck. No loudnorm, no alimiter — dynamic normalisers pump
# and lift the noise floor between sentences; a loudnorm mix of this exact
# pipeline shipped audible static (pause floor -41 dBFS against -44..-46 for
# every static-gain mix). render_check.mjs now fails that floor.
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
#    measured static gains (see header).
DUR=$(ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$WORK/${SLUG}-voice.mp4")
"$VOX_PY" "$VIDEO_DIR/gen_music.py" "$DUR" "$WORK/music_$SLUG.wav" >/dev/null
lufs() {
  ffmpeg -hide_banner -i "$1" -af ebur128=framelog=quiet -f null /dev/null 2>&1 |
    grep -E "^\s+I:" | tail -1 | grep -oE '\-?[0-9.]+'
}
VI=$(lufs "$WORK/${SLUG}-voice.mp4")
MI=$(lufs "$WORK/music_$SLUG.wav")
VG=$(python3 -c "print(f'{-16.5 - ($VI):.1f}')")
MG=$(python3 -c "print(f'{-36.5 - ($MI):.1f}')")
echo "  voice $VI LUFS (gain ${VG} dB), bed $MI LUFS (gain ${MG} dB)"
ffmpeg -v error -y -i "$WORK/${SLUG}-voice.mp4" -i "$WORK/music_$SLUG.wav" -filter_complex \
  "[0:a]volume=${VG}dB,asplit=2[v][k];[1:a]volume=${MG}dB,lowpass=f=3500[m];\
   [m][k]sidechaincompress=threshold=0.03:ratio=4:attack=20:release=320[d];\
   [v][d]amix=inputs=2:normalize=0:duration=first[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k "$WORK/${SLUG}-music.mp4"

# 5. poster title card + 1s lead — final 1080p only (the poster must match the
#    video resolution). For previews, the music cut IS the final.
POSTER_T="${POSTER_T:-2.6}" # a settled moment of the title beat
if [ "$Q" = "h" ]; then
  ffmpeg -v error -y -ss "$POSTER_T" -i "$WORK/${SLUG}-music.mp4" -frames:v 1 "$WORK/poster_$SLUG.png"
  ffmpeg -v error -y -loop 1 -t 1.0 -i "$WORK/poster_$SLUG.png" -i "$WORK/${SLUG}-music.mp4" \
    -f lavfi -t 1.0 -i anullsrc=r=48000:cl=stereo \
    -filter_complex "[0:v]scale=1920:1080,fps=60,setsar=1,format=yuv420p[lead];[2:a]aformat=sample_rates=48000:channel_layouts=stereo[sil];[lead][sil][1:v][1:a]concat=n=2:v=1:a=1[v][a]" \
    -map "[v]" -map "[a]" -c:v libx264 -crf 20 -preset medium -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart \
    "$WORK/${SLUG}-final.mp4"
else
  cp "$WORK/${SLUG}-music.mp4" "$WORK/${SLUG}-final.mp4"
fi

echo "=== done: $WORK/${SLUG}-final.mp4 ($(ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$WORK/${SLUG}-final.mp4")s) ==="
