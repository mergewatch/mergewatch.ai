#!/usr/bin/env bash
# =============================================================================
# Render one changelog section for a version, from conventional commits.
# =============================================================================
# Usage: scripts/changelog-section.sh <version> [--since <ref>] [--no-heading]
#
#   <version>       e.g. 0.7.0 or v0.7.0
#   --since <ref>   Start of the range. Defaults to the most recent tag.
#   --no-heading    Emit only the grouped sections, without the `## [version]`
#                   line — for a GitHub Release, whose title already IS the
#                   version.
#
# #550 — extracted from release.sh so ONE generator feeds both CHANGELOG.md and
# the release notes. Two implementations of "what changed in this release" would
# disagree the first time either was touched, and the release notes are the copy
# a user reads.
set -euo pipefail

VERSION=""
SINCE=""
HEADING=1
while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE="${2:?--since needs a ref}"; shift 2 ;;
    --no-heading) HEADING=0; shift ;;
    *) VERSION="$1"; shift ;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "Usage: scripts/changelog-section.sh <version> [--since <ref>] [--no-heading]" >&2
  exit 1
fi
VERSION="${VERSION#v}"
TAG="v${VERSION}"
TODAY=$(date +%Y-%m-%d)

# Default to the most recent tag. On a repo with no tags at all, fall back to
# the whole history rather than failing — a first release is a real case.
if [ -z "$SINCE" ]; then
  SINCE=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
fi

if [ -n "$SINCE" ]; then
  RANGE="${SINCE}..HEAD"
  COMPARE_URL="https://github.com/mergewatch/mergewatch.ai/compare/${SINCE}...${TAG}"
else
  RANGE="HEAD"
  COMPARE_URL="https://github.com/mergewatch/mergewatch.ai/commits/${TAG}"
fi

# `- <subject> (<short sha>)`. The repo's commit convention already carries the
# issue numbers in the subject — `fix(core): … (#544) (#547)` — so linking is
# GitHub's autolinking rather than anything this has to construct.
collect() { git log $RANGE --no-merges --format="- %s (%h)" "$@" 2>/dev/null || true; }

FEATURES=$(collect --grep="^feat")
FIXES=$(collect --grep="^fix")
OTHERS=$(collect --invert-grep --grep="^feat" --grep="^fix" --grep="^chore" --grep="^docs" --grep="^ci" --grep="^test")

OUT=""
[ "$HEADING" -eq 1 ] && OUT="## [${VERSION}](${COMPARE_URL}) (${TODAY})"$'\n'
[ -n "$FEATURES" ] && OUT+=$'\n'"### Features"$'\n'"${FEATURES}"$'\n'
[ -n "$FIXES" ]    && OUT+=$'\n'"### Bug Fixes"$'\n'"${FIXES}"$'\n'
[ -n "$OTHERS" ]   && OUT+=$'\n'"### Other Changes"$'\n'"${OTHERS}"$'\n'

# A release with nothing conventional in range is a real case — a docs-only or
# chore-only release. Say so rather than emitting an empty section that reads
# like the generator broke.
if [ -z "$FEATURES$FIXES$OTHERS" ]; then
  COUNT=$(git log $RANGE --no-merges --oneline 2>/dev/null | wc -l | tr -d ' ')
  OUT+=$'\n'"_No feature or fix commits in this range (${COUNT} commit(s) since ${SINCE:-the start})._"$'\n'
fi

printf '%s' "$OUT"
