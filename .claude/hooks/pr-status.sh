#!/usr/bin/env bash
# Summarize the current branch's PR + CI status as Claude Code hook context.
# Stays SILENT (no output, exit 0) when gh is missing/unauthed or no PR exists,
# so the token cost is ~zero except when there's an actual PR to report on.
#
# Usage: pr-status.sh <HookEventName>   (e.g. PostToolUse, SessionStart)
set -euo pipefail
event="${1:-PostToolUse}"

command -v gh >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0
[ -n "$branch" ] && [ "$branch" != "HEAD" ] || exit 0

pr=$(gh pr view "$branch" \
  --json number,state,mergeStateStatus,reviewDecision,url,statusCheckRollup \
  2>/dev/null) || exit 0
[ -n "$pr" ] || exit 0

summary=$(printf '%s' "$pr" | jq -r '
  (.statusCheckRollup // []) as $c
  | ($c | length) as $total
  | ($c | map(select(
        (.conclusion // "") as $k
        | $k=="FAILURE" or $k=="TIMED_OUT" or $k=="CANCELLED"
          or $k=="ACTION_REQUIRED" or $k=="STARTUP_FAILURE"
          or (.state // "")=="FAILURE" or (.state // "")=="ERROR"
      )) | length) as $fail
  | ($c | map(select(
        (.conclusion // "")!="" or (.state // "")=="SUCCESS"
          or (.state // "")=="FAILURE" or (.state // "")=="ERROR"
      )) | length) as $done
  | (if (.reviewDecision // "") == "" then "NONE" else .reviewDecision end) as $review
  | "PR #\(.number) [\(.state)] mergeState=\(.mergeStateStatus) "
    + "review=\($review) | checks: \($total) total, "
    + "\($fail) failing, \(($total - $done)) pending\n\(.url)"
')
[ -n "$summary" ] || exit 0

jq -cn --arg e "$event" --arg s "Open PR for the current branch ($branch): $summary" \
  '{hookSpecificOutput: {hookEventName: $e, additionalContext: $s}}'
