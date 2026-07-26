#!/bin/bash
# Scheduled local pass over submitted explainer-video contributions.
#
#   GIVEWORK_ADMIN_TOKEN=… ./verify_queue.sh [--dry-run]
#
# The control plane runs on Cloudflare Workers, which has no ffmpeg and cannot
# decode video, so the objective check runs here — the same arrangement
# proof_checker and replication already use, where a maintainer's machine stands
# in for a sandbox and posts an authoritative verdict.
#
# For each submitted video task it: fetches the contributor's merged spec + scene,
# renders the scene, measures it with render_check.mjs, and posts pass/fail with
# the full measurement report attached as the verification's detail. A pass still
# leaves the task for a maintainer's eye on taste; what this removes is having to
# watch every submission to find the ones that are simply broken.
#
# Suggested schedule (launchd on macOS, every 30 minutes):
#   ~/Library/LaunchAgents/dev.givework.verify.plist -> ProgramArguments:
#     /bin/bash -lc 'cd <repo>/video && GIVEWORK_ADMIN_TOKEN=… ./verify_queue.sh'
#   StartInterval: 1800
# or crontab:
#   */30 * * * * cd <repo>/video && GIVEWORK_ADMIN_TOKEN=… ./verify_queue.sh >> /tmp/gw-verify.log 2>&1
set -uo pipefail

API="${GIVEWORK_API_URL:-https://api.givework.dev}"
TOKEN="${GIVEWORK_ADMIN_TOKEN:?set GIVEWORK_ADMIN_TOKEN}"
CONTRIB="${GIVEWORK_CONTRIB_REPO:-Barneyjm/givework-contrib}"
IMAGE="${MANIM_IMAGE:-docker.io/manimcommunity/manim:stable}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

api() { curl -sS -H "authorization: Bearer $TOKEN" "$@"; }

# Only tasks whose declared verification IS this check.
TASKS="$(api "$API/admin/tasks?status=submitted" |
  python3 -c '
import json,sys
try: rows=json.load(sys.stdin)
except Exception: sys.exit(0)
rows = rows if isinstance(rows,list) else rows.get("tasks",[])
for t in rows:
    if t.get("verify_via")=="render_check":
        print(t["id"])
')"

[ -z "$TASKS" ] && { echo "$(date -u +%FT%TZ) nothing awaiting render_check"; exit 0; }

for id in $TASKS; do
  echo "=== $id ==="
  WORK="$(mktemp -d)"
  # The contribution's files land in the contrib repo once its PR is merged.
  slug="$(api "$API/admin/tasks?status=submitted" |
    python3 -c "
import json,sys
rows=json.load(sys.stdin); rows = rows if isinstance(rows,list) else rows.get('tasks',[])
for t in rows:
    if t['id']=='$id':
        r=t.get('result') or {}
        print(r.get('slug') or (t.get('title','').rsplit(' for ',1)[-1].strip().lower().replace(' ','-')))
        break
")"
  if [ -z "$slug" ]; then echo "  ! could not determine slug; skipping"; rm -rf "$WORK"; continue; fi

  base="https://raw.githubusercontent.com/$CONTRIB/main/$slug/explainer"
  curl -sSf "$base/$slug.json"    -o "$WORK/$slug.json"     || { echo "  ! spec not merged yet"; rm -rf "$WORK"; continue; }
  curl -sSf "$base/sc_$slug.py"   -o "$WORK/sc_$slug.py"    || { echo "  ! scene not merged yet"; rm -rf "$WORK"; continue; }
  cp "$HERE/viz.py" "$WORK/viz.py"

  # Render low-res: enough to measure composition, colour, motion and framing.
  if ! podman run --rm --network=none \
        -e SPEC_PATH="/m/$slug.json" -e NARR_DIR="/m/narration_$slug" \
        -v "$WORK:/m" -w /m "$IMAGE" \
        manim -ql --disable_caching "sc_$slug.py" ConjectureVideo >"$WORK/render.log" 2>&1; then
    verdict=failed
    detail="$(python3 -c "
import json;print(json.dumps({'stage':'render','error':open('$WORK/render.log').read()[-1500:]}))")"
  else
    vid="$(find "$WORK/media" -name 'ConjectureVideo.mp4' | head -1)"
    starts="$WORK/narration_$slug/starts.json"
    args=("$vid" --json); [ -f "$starts" ] && args+=(--starts "$starts")
    report="$(node "$HERE/render_check.mjs" "${args[@]}" 2>/dev/null)"
    verdict="$(printf '%s' "$report" | python3 -c "import json,sys;print('passed' if json.load(sys.stdin)['verdict']=='pass' else 'failed')")"
    detail="$report"
  fi

  echo "  verdict: $verdict"
  if [ "$DRY" = "1" ]; then
    printf '%s' "$detail" | head -c 400; echo
  else
    printf '%s' "$detail" | python3 -c "
import json,sys
print(json.dumps({'verdict':'$verdict','detail':json.load(sys.stdin)}))" |
      api -X POST -H 'content-type: application/json' --data @- \
        "$API/admin/tasks/$id/verify" >/dev/null &&
      echo "  posted"
  fi
  rm -rf "$WORK"
done
