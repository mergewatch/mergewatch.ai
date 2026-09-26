#!/usr/bin/env bash
#
# Verify that container images were actually published — by asking the REGISTRY,
# not by trusting the publisher's exit code. (#665)
#
# v0.6.5 was reported as `Cut the release: failure` on a release that shipped
# completely. buildx hit a transient `error writing layer blob: not_found`,
# recovered, pushed everything, and still exited non-zero; the release gate read
# `gh run watch --exit-status` and failed the release. Both images were intact —
# 7 and 8 layers, nothing missing, `latest` correct.
#
# The inverse hole is just as real and is the reason this script checks the
# registry rather than merely skipping the exit code: v0.6.0 shipped a tag and a
# GitHub release with NO images and reported success (#513). So the verdict has
# to come from something that can distinguish the two, and neither the run
# conclusion nor the presence of a tag can.
#
# What is checked, per image:
#   1. `<version>` resolves to a manifest at all.
#   2. If that manifest is an index, it is followed to a platform manifest —
#      an index alone has no layers, so stopping there proves nothing.
#   3. Every layer blob is HEAD-able, and there is at least one of them.
#   4. The moving tags (`latest`, `MAJOR.MINOR`) resolve to the SAME digest as
#      `<version>`. Presence is not enough: a `latest` left pointing at the
#      previous release is invisible to a presence check and is the failure a
#      user actually hits.
#
# Needs no credentials for a public package — an anonymous pull token is enough.
#
# Usage:
#   scripts/verify-published-images.sh <version> <repo> [<repo> ...]
#   scripts/verify-published-images.sh v0.6.5 \
#       mergewatch/mergewatch mergewatch/mergewatch-dashboard
#
# REGISTRY_BASE overrides the registry root (scheme included). It exists so the
# checks can be exercised against a fake registry in tests — a missing layer
# blob cannot be induced against GHCR on demand.
set -uo pipefail

REGISTRY_BASE="${REGISTRY_BASE:-https://ghcr.io}"

# Ask for every manifest media type. Omitting the OCI index types makes a
# multi-arch image 404 on registries that do strict content negotiation.
ACCEPT='application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <version> <repo> [<repo> ...]" >&2
  exit 2
fi

# The registry tag has no `v`: metadata-action's `type=semver,pattern={{version}}`
# strips it, so `v0.6.5` is published as `0.6.5`. Accept either spelling here so
# a caller passing the git tag verbatim checks the right thing.
VERSION="${1#v}"
shift
REPOS=("$@")

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::version must look like N.N.N (got '$VERSION')" >&2
  exit 2
fi
MAJOR_MINOR="${VERSION%.*}"

FAILURES=0
fail() {
  echo "::error::$*" >&2
  FAILURES=$((FAILURES + 1))
}

MANIFEST_BODY="$(mktemp)"
HEADER_FILE="$(mktemp)"
trap 'rm -f "$MANIFEST_BODY" "$HEADER_FILE"' EXIT

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

registry_token() { # $1=repo
  local host="${REGISTRY_BASE#*://}"
  curl -fsSL "${REGISTRY_BASE}/token?scope=repository:${1}:pull&service=${host}" \
    2>/dev/null | jq -r '.token // empty' 2>/dev/null
}

# fetch_manifest <repo> <reference> <token>
# Prints the manifest digest; leaves the body in $MANIFEST_BODY. Returns 1 if
# the reference does not resolve.
fetch_manifest() {
  local repo="$1" ref="$2" tok="$3"
  : >"$HEADER_FILE"
  if ! curl -fsSL -D "$HEADER_FILE" -o "$MANIFEST_BODY" \
    -H "Authorization: Bearer $tok" -H "Accept: $ACCEPT" \
    "${REGISTRY_BASE}/v2/${repo}/manifests/${ref}" >/dev/null 2>&1; then
    return 1
  fi
  # `-L` may have followed redirects, so several response header blocks can be
  # in the file; the last Docker-Content-Digest is the one for the manifest.
  local digest
  digest="$(tr -d '\r' <"$HEADER_FILE" \
    | awk 'tolower($1) == "docker-content-digest:" { print $2 }' | tail -n1)"
  # Fall back to hashing the bytes. The content digest IS the sha256 of the
  # manifest as served, so this is equivalent — registries are just not all
  # required to send the header.
  [ -n "$digest" ] || digest="sha256:$(sha256_of "$MANIFEST_BODY")"
  printf '%s' "$digest"
}

# verify_layers <repo> <tag> <token> — $MANIFEST_BODY must hold <tag>'s manifest.
verify_layers() {
  local repo="$1" tag="$2" tok="$3"
  local body
  body="$(cat "$MANIFEST_BODY")"

  if jq -e 'has("manifests")' >/dev/null 2>&1 <<<"$body"; then
    local platform
    platform="$(jq -r '.manifests[0].digest // empty' <<<"$body")"
    if [ -z "$platform" ]; then
      fail "${repo}:${tag} — image index lists no platform manifests"
      return 1
    fi
    if ! fetch_manifest "$repo" "$platform" "$tok" >/dev/null; then
      fail "${repo}:${tag} — platform manifest ${platform} does not resolve"
      return 1
    fi
    body="$(cat "$MANIFEST_BODY")"
  fi

  local layers=0 missing=0 digest
  while read -r digest; do
    [ -n "$digest" ] || continue
    layers=$((layers + 1))
    if ! curl -fsSL -I -o /dev/null \
      -H "Authorization: Bearer $tok" \
      "${REGISTRY_BASE}/v2/${repo}/blobs/${digest}" 2>/dev/null; then
      fail "${repo}:${tag} — layer blob ${digest} is missing from the registry"
      missing=$((missing + 1))
    fi
  done < <(jq -r '.layers[]?.digest // empty' <<<"$body")

  if [ "$layers" -eq 0 ]; then
    fail "${repo}:${tag} — manifest resolves but lists no layers"
    return 1
  fi
  echo "  layers: ${layers}, missing: ${missing}"
  [ "$missing" -eq 0 ]
}

echo "verifying ${#REPOS[@]} image(s) at version ${VERSION} against ${REGISTRY_BASE}"

for repo in "${REPOS[@]}"; do
  echo "${repo}:${VERSION}"
  token="$(registry_token "$repo")"
  if [ -z "$token" ]; then
    fail "${repo} — could not obtain a pull token from ${REGISTRY_BASE}"
    continue
  fi

  if ! version_digest="$(fetch_manifest "$repo" "$VERSION" "$token")"; then
    fail "${repo}:${VERSION} — tag is absent from the registry (no manifest)"
    continue
  fi
  echo "  digest: ${version_digest}"

  verify_layers "$repo" "$VERSION" "$token"

  for moving in latest "$MAJOR_MINOR"; do
    if ! moving_digest="$(fetch_manifest "$repo" "$moving" "$token")"; then
      fail "${repo}:${moving} — moving tag is absent from the registry (no manifest)"
      continue
    fi
    if [ "$moving_digest" != "$version_digest" ]; then
      fail "${repo}:${moving} — stale moving tag: points at ${moving_digest}, but ${VERSION} is ${version_digest}"
    else
      echo "  ${moving} == ${VERSION} (${moving_digest})"
    fi
  done
done

if [ "$FAILURES" -ne 0 ]; then
  echo "::error::registry verification failed ${FAILURES} check(s) — the images for ${VERSION} are not complete" >&2
  exit 1
fi
echo "all ${#REPOS[@]} image(s) verified complete at ${VERSION}, with matching latest and ${MAJOR_MINOR}"
