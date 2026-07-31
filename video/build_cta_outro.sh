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

# short music bed under the voice — same static-gain recipe as produce_video.sh
# (voice to -16.5 LUFS capped by true-peak headroom, bed measured through its
# lowpass and set 20 LU under), so the levels match at the concat seam
DUR=$(ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$WORK/cta_voice.mp4")
"$VOX_PY" "$VIDEO_DIR/gen_music.py" "$DUR" "$WORK/music_cta.wav" >/dev/null
read -r VOICE_I VOICE_TP <<<"$(ffmpeg -hide_banner -nostdin -i "$WORK/cta_voice.mp4" \
  -af ebur128=peak=true -f null - 2>&1 | tail -20 | awk '$1=="I:"{i=$2} $1=="Peak:"{p=$2} END{print i, p}')"
BED_I=$(ffmpeg -hide_banner -nostdin -i "$WORK/music_cta.wav" -af "lowpass=f=3500,ebur128" \
  -f null - 2>&1 | tail -20 | awk '$1=="I:"{i=$2} END{print i}')
read -r VGAIN BGAIN VOUT <<<"$(python3 -c "
vi, vtp, bi = $VOICE_I, $VOICE_TP, $BED_I
g = min(-16.5 - vi, -1.5 - vtp)   # loudness target, capped by true-peak headroom
print(round(g, 2), round((vi + g - 20.0) - bi, 2), round(vi + g, 2))")"
echo "  static gains: voice ${VGAIN}dB (I=${VOICE_I} TP=${VOICE_TP} -> ~${VOUT} LUFS), bed ${BGAIN}dB (20 LU under)"
ffmpeg -v error -y -i "$WORK/cta_voice.mp4" -i "$WORK/music_cta.wav" -filter_complex \
  "[0:a]volume=${VGAIN}dB,asplit=2[v][k];[1:a]volume=${BGAIN}dB,lowpass=f=3500[m];\
   [m][k]sidechaincompress=threshold=0.03:ratio=4:attack=20:release=320[d];\
   [v][d]amix=inputs=2:normalize=0:duration=first[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k "$WORK/cta_outro.mp4"
echo "=== cta_outro.mp4 ready ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$WORK/cta_outro.mp4")s) ==="
