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

# Validate the ref before it reaches git.
#
# Not shell injection — an expanded variable is an ARGUMENT, and bash does not
# re-parse it for metacharacters, so `HEAD; rm -rf /` reaches git as a single
# bad ref and is rejected. The real hazard is narrower: a value starting with
# `-` would be read by git as an OPTION rather than a revision, which is
# argument injection proper. Whitespace and globs would also split or expand
# into a malformed invocation.
#
# No caller passes --since today, so this is defence for a flag that exists to
# be used later rather than a fix for a live path.
if [ -n "$SINCE" ] && ! printf '%s' "$SINCE" | grep -qE '^[A-Za-z0-9._/^~-]+$'; then
  echo "Error: --since must be a plain git ref (got '$SINCE')" >&2
  exit 1
fi
case "$SINCE" in
  -*) echo "Error: --since must not start with '-' (got '$SINCE')" >&2; exit 1 ;;
esac

if [ -n "$SINCE" ]; then
  RANGE="${SINCE}..HEAD"
  COMPARE_URL="https://github.com/mergewatch/mergewatch.ai/compare/${SINCE}...${TAG}"
else
  RANGE="HEAD"
  COMPARE_URL="https://github.com/mergewatch/mergewatch.ai/commits/${TAG}"
fi

# Confirm the range resolves BEFORE collecting.
#
# Review finding on #580 (clustered warning): `collect()` ends in
# `2>/dev/null || true`, so a git failure there returns empty and the script
# reports "no feature or fix commits in this range" — a wrong range and an
# uneventful release rendering identically. In a release that means notes
# claiming nothing changed.
#
# Today a bad ref does still fail, but only because the empty-range branch runs
# `git log` again under pipefail. That is correct by ACCIDENT: one edit to that
# line removes the protection with nothing to say so. Checking here makes it
# intentional.
if ! git rev-list --max-count=1 "$RANGE" >/dev/null 2>&1; then
  echo "Error: range '$RANGE' does not resolve — refusing to report an empty changelog for it" >&2
  exit 1
fi

# `- <subject> (<short sha>)`. The repo's commit convention already carries the
# issue numbers in the subject — `fix(core): … (#544) (#547)` — so linking is
# GitHub's autolinking rather than anything this has to construct.
# `"$RANGE"` quoted, and `--` closes the revision list so nothing after it can
# be read as a path or an option.
collect() { git log "$RANGE" --no-merges --format="- %s (%h)" "$@" -- 2>/dev/null || true; }

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
  COUNT=$(git log "$RANGE" --no-merges --oneline -- 2>/dev/null | wc -l | tr -d ' ')
  OUT+=$'\n'"_No feature or fix commits in this range (${COUNT} commit(s) since ${SINCE:-the start})._"$'\n'
fi

printf '%s' "$OUT"
