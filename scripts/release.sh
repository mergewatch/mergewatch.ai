#!/usr/bin/env bash
# =============================================================================
# MergeWatch Release Script
# =============================================================================
# Usage:  ./scripts/release.sh <version>
# Example: ./scripts/release.sh 0.2.0
#
# This script:
#   1. Updates version in root + all workspace package.json files
#   2. Updates the hardcoded version in the server health check
#   3. Updates docker-compose.yml image tags
#   4. Generates a changelog section from conventional commits
#   5. Commits, tags, and prints push instructions
# =============================================================================

set -euo pipefail

# ── Validate input ──────────────────────────────────────────────────────────

VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "Usage: ./scripts/release.sh <version>"
  echo "Example: ./scripts/release.sh 0.2.0"
  exit 1
fi

# Strip leading 'v' if provided (e.g. v0.2.0 → 0.2.0)
VERSION="${VERSION#v}"

# Validate semver format
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$'; then
  echo "Error: '$VERSION' is not a valid semver version (expected X.Y.Z)"
  exit 1
fi

TAG="v${VERSION}"

# ── Pre-flight checks ──────────────────────────────────────────────────────

# Must be on main branch
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  echo "Error: Must be on 'main' branch (currently on '$BRANCH')"
  exit 1
fi

# Working tree must be clean
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: Working tree has uncommitted changes. Commit or stash first."
  exit 1
fi

# Tag must not already exist
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: Tag '$TAG' already exists"
  exit 1
fi

echo "Releasing MergeWatch $TAG"
echo ""

# ── Step 1: Update package.json versions ────────────────────────────────────

REPO_ROOT=$(git rev-parse --show-toplevel)

# All package.json files to update
PACKAGE_FILES=(
  "$REPO_ROOT/package.json"
  "$REPO_ROOT/packages/core/package.json"
  "$REPO_ROOT/packages/server/package.json"
  "$REPO_ROOT/packages/lambda/package.json"
  "$REPO_ROOT/packages/dashboard/package.json"
  "$REPO_ROOT/packages/billing/package.json"
  "$REPO_ROOT/packages/storage-dynamo/package.json"
  "$REPO_ROOT/packages/storage-postgres/package.json"
  "$REPO_ROOT/packages/llm-anthropic/package.json"
  "$REPO_ROOT/packages/llm-bedrock/package.json"
  "$REPO_ROOT/packages/llm-litellm/package.json"
  "$REPO_ROOT/packages/llm-ollama/package.json"
)

for f in "${PACKAGE_FILES[@]}"; do
  if [ -f "$f" ]; then
    # Use node to update version field (preserves formatting)
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('$f', 'utf8'));
      pkg.version = '$VERSION';
      fs.writeFileSync('$f', JSON.stringify(pkg, null, 2) + '\n');
    "
    echo "  Updated $(echo "$f" | sed "s|$REPO_ROOT/||")"
  fi
done

# ── Step 2: Update server health check version ─────────────────────────────

SERVER_INDEX="$REPO_ROOT/packages/server/src/index.ts"
if [ -f "$SERVER_INDEX" ]; then
  sed "s/version: '[^']*'/version: '$VERSION'/" "$SERVER_INDEX" > "$SERVER_INDEX.tmp" \
    && mv "$SERVER_INDEX.tmp" "$SERVER_INDEX"
  echo "  Updated packages/server/src/index.ts health check version"
fi

# ── Step 3: Update docker-compose.yml image tags ───────────────────────────

COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
if [ -f "$COMPOSE_FILE" ]; then
  sed \
    -e "s|ghcr.io/mergewatch/mergewatch:[^ ]*|ghcr.io/mergewatch/mergewatch:${VERSION}|" \
    -e "s|ghcr.io/mergewatch/mergewatch-dashboard:[^ ]*|ghcr.io/mergewatch/mergewatch-dashboard:${VERSION}|" \
    "$COMPOSE_FILE" > "$COMPOSE_FILE.tmp" \
    && mv "$COMPOSE_FILE.tmp" "$COMPOSE_FILE"
  echo "  Updated docker-compose.yml image tags"
fi

# ── Step 4: Generate changelog ──────────────────────────────────────────────

CHANGELOG="$REPO_ROOT/CHANGELOG.md"
TODAY=$(date +%Y-%m-%d)

# Find previous tag (if any)
PREV_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

if [ -n "$PREV_TAG" ]; then
  RANGE="${PREV_TAG}..HEAD"
  COMPARE_URL="https://github.com/santthosh/mergewatch.ai/compare/${PREV_TAG}...${TAG}"
else
  RANGE="HEAD"
  COMPARE_URL="https://github.com/santthosh/mergewatch.ai/commits/${TAG}"
fi

# Collect commits grouped by type
FEATURES=$(git log $RANGE --oneline --no-merges --grep="^feat" --format="- %s (%h)" 2>/dev/null || true)
FIXES=$(git log $RANGE --oneline --no-merges --grep="^fix" --format="- %s (%h)" 2>/dev/null || true)
OTHERS=$(git log $RANGE --oneline --no-merges --invert-grep --grep="^feat" --grep="^fix" --grep="^chore" --grep="^docs" --grep="^ci" --grep="^test" --format="- %s (%h)" 2>/dev/null || true)

# Build the new changelog section
NEW_SECTION="## [${VERSION}](${COMPARE_URL}) (${TODAY})"$'\n'
if [ -n "$FEATURES" ]; then
  NEW_SECTION+=$'\n'"### Features"$'\n'"${FEATURES}"$'\n'
fi
if [ -n "$FIXES" ]; then
  NEW_SECTION+=$'\n'"### Bug Fixes"$'\n'"${FIXES}"$'\n'
fi
if [ -n "$OTHERS" ]; then
  NEW_SECTION+=$'\n'"### Other Changes"$'\n'"${OTHERS}"$'\n'
fi

if [ -f "$CHANGELOG" ]; then
  # Prepend new section after the header line
  HEADER=$(head -n 2 "$CHANGELOG")
  BODY=$(tail -n +3 "$CHANGELOG")
  echo "${HEADER}"$'\n\n'"${NEW_SECTION}"$'\n'"${BODY}" > "$CHANGELOG"
else
  # Create new changelog
  echo "# Changelog"$'\n\n'"${NEW_SECTION}" > "$CHANGELOG"
fi
echo "  Updated CHANGELOG.md"

# ── Step 5: Commit and tag ─────────────────────────────────────────────────

echo ""
git add -A
git commit -m "chore: release ${TAG}"
git tag -a "$TAG" -m "Release ${TAG}"

echo ""
echo "============================================="
echo "  Release ${TAG} prepared successfully!"
echo "============================================="
echo ""
echo "Next steps:"
echo "  1. Push the commit and tag:"
echo "     git push && git push --tags"
echo ""
echo "  2. Create the GitHub Release:"
echo "     gh release create ${TAG} --generate-notes"
echo ""
echo "  3. This will trigger:"
echo "     - Docker images: ghcr.io/mergewatch/mergewatch:${VERSION}"
echo "     - Docker images: ghcr.io/mergewatch/mergewatch-dashboard:${VERSION}"
echo "     - SAM deploy to dev (auto), prod (manual approval)"
echo ""
