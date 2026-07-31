#!/bin/bash
# Render the modular CTA outro clip ONCE (reused across all videos): render the
# scene silent, mux the reusable CTA voiceover, mix a short music bed. No
# poster lead-in — this is a tail clip, not a standalone video.
#
#   build_cta_outro.sh
#
# Needs narration_cta/ (the recorded CTA voiceover + durations.json) in $WORK.
# Output: $WORK/cta_outro.mp4 — copy or point CTA_OUTRO at it for bolt_cta.sh.
#
# Environment (all optional): WORK, VOX_DIR, VOX_PY, ENGINE, MANIM_IMG as in
# produce_video.sh. Mix discipline: measured static gains only, no loudnorm.
set -euo pipefail

VIDEO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${WORK:-$PWD}"
VOX_DIR="${VOX_DIR:-$HOME/Documents/code/VoxCPM}"
VOX_PY="${VOX_PY:-$VOX_DIR/.venv/bin/python}"
ENGINE="${ENGINE:-podman}"
IMG="${MANIM_IMG:-docker.io/manimcommunity/manim:stable}"

[ -f "$WORK/narration_cta/durations.json" ] || {
  echo "missing $WORK/narration_cta/ (the reusable CTA voiceover)"; exit 1;
}

cd "$WORK"
rm -rf media/videos/cta_outro
"$ENGINE" run --rm -e NARR_DIR="/work/narration_cta" -e PYTHONPATH="/kit:/kit/manim" \
  -v "$WORK:/work" -v "$VIDEO_DIR:/kit:ro" -w /work "$IMG" \
  manim -qh --disable_caching /kit/cta_outro.py CTAOutro 2>&1 | tail -2
CVID="media/videos/cta_outro/1080p60/CTAOutro.mp4"
[ -f "$CVID" ] || { echo "render did not produce $CVID"; exit 1; }

# mux CTA narration at its recorded start
python3 - "narration_cta" "$CVID" "$WORK/cta_voice.mp4" <<'PY'
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

# short music bed under the voice — same static-gain recipe as produce_video.sh,
# so the levels match at the concat seam
DUR=$(ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$WORK/cta_voice.mp4")
"$VOX_PY" "$VIDEO_DIR/gen_music.py" "$DUR" "$WORK/music_cta.wav" >/dev/null
lufs() {
  ffmpeg -hide_banner -i "$1" -af ebur128=framelog=quiet -f null /dev/null 2>&1 |
    grep -E "^\s+I:" | tail -1 | grep -oE '\-?[0-9.]+'
}
VI=$(lufs "$WORK/cta_voice.mp4")
MI=$(lufs "$WORK/music_cta.wav")
VG=$(python3 -c "print(f'{-16.5 - ($VI):.1f}')")
MG=$(python3 -c "print(f'{-36.5 - ($MI):.1f}')")
echo "  voice $VI LUFS (gain ${VG} dB), bed gain ${MG} dB"
ffmpeg -v error -y -i "$WORK/cta_voice.mp4" -i "$WORK/music_cta.wav" -filter_complex \
  "[0:a]volume=${VG}dB,asplit=2[v][k];[1:a]volume=${MG}dB,lowpass=f=3500[m];\
   [m][k]sidechaincompress=threshold=0.03:ratio=4:attack=20:release=320[d];\
   [v][d]amix=inputs=2:normalize=0:duration=first[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k "$WORK/cta_outro.mp4"
echo "=== cta_outro.mp4 ready ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$WORK/cta_outro.mp4")s) ==="
