#!/usr/bin/env bash
# =============================================================================
# MergeWatch Deploy Script
# =============================================================================
#
# One-command deployment for MergeWatch infrastructure.
#
# Usage:
#   ./scripts/deploy.sh              # Deploy to production (default)
#   ./scripts/deploy.sh staging      # Deploy to staging
#   ./scripts/deploy.sh dev          # Deploy to development
#   ./scripts/deploy.sh --guided     # Interactive first-time setup
#
# Prerequisites:
#   1. AWS CLI installed and configured (aws configure)
#   2. AWS SAM CLI installed (brew install aws-sam-cli)
#   3. Node.js 20.x installed (for building Lambda functions)
#   4. SSM parameters populated (run ./scripts/setup-ssm.sh first)
#
# What this script does:
#   1. Validates that required tools are installed
#   2. Runs `sam build` to compile TypeScript and bundle Lambda functions
#   3. Runs `sam deploy` to create/update the CloudFormation stack
#   4. Prints the webhook URL on success
# =============================================================================

set -euo pipefail

# --- Configuration ---
# Root directory of the project (one level up from scripts/)
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="${PROJECT_ROOT}/infra"

# Deployment environment (default: "default" which maps to prod in samconfig.toml)
ENVIRONMENT="${1:-default}"

# --- Color output helpers ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# --- Prerequisite checks ---
check_prerequisites() {
  local missing=0

  if ! command -v aws &>/dev/null; then
    error "AWS CLI is not installed. Install it: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
    missing=1
  fi

  if ! command -v sam &>/dev/null; then
    error "AWS SAM CLI is not installed. Install it: brew install aws-sam-cli"
    missing=1
  fi

  if ! command -v node &>/dev/null; then
    error "Node.js is not installed. Install v20.x: https://nodejs.org/"
    missing=1
  else
    # Check Node.js version (need 20.x)
    NODE_VERSION=$(node --version | cut -d'.' -f1 | tr -d 'v')
    if [ "$NODE_VERSION" -lt 20 ]; then
      warn "Node.js version $(node --version) detected. Node.js 20.x or later is recommended."
    fi
  fi

  # Verify AWS credentials are configured
  if ! aws sts get-caller-identity &>/dev/null; then
    error "AWS credentials are not configured. Run: aws configure"
    missing=1
  fi

  if [ $missing -ne 0 ]; then
    error "Missing prerequisites. Please install the tools listed above."
    exit 1
  fi

  info "All prerequisites satisfied."
}

# --- Build ---
build() {
  info "Installing workspace dependencies..."
  cd "$PROJECT_ROOT"
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install

  info "Building workspace packages..."
  pnpm run build

  info "Building SAM Lambda functions..."
  cd "$INFRA_DIR"

  sam build \
    --parallel \
    --cached

  info "Build complete."
}

# --- Deploy ---
deploy() {
  info "Deploying MergeWatch (environment: ${ENVIRONMENT})..."
  cd "$INFRA_DIR"

  # #264 — pass every stack parameter explicitly, from the same per-stage files
  # the CI workflow uses. CloudFormation retains the existing value for any
  # parameter a deploy omits, so an omitted parameter is a silent pin, not a
  # fallback to the template's Default. `prod` maps to params/prod.env; any
  # other named environment maps to params/<env>.env when one exists.
  local stage_file="params/${ENVIRONMENT}.env"
  [ "$ENVIRONMENT" = "default" ] && stage_file="params/prod.env"

  local stack_params=""
  if [ -f "$stage_file" ]; then
    stack_params=$(grep -vE '^[[:space:]]*(#|$)' "$stage_file" | tr '\n' ' ')
    info "Stack parameters from ${stage_file}: ${stack_params}"
  else
    warn "No ${stage_file} — deploying without explicit parameter overrides."
    warn "CloudFormation will RETAIN the stack's current values; the template's"
    warn "Default: does not apply to an existing stack. See #264."
  fi

  if [ "$ENVIRONMENT" = "--guided" ]; then
    # Interactive first-time setup
    sam deploy --guided
  elif [ "$ENVIRONMENT" = "default" ]; then
    # Use default config from samconfig.toml
    sam deploy ${stack_params:+--parameter-overrides "$stack_params"}
  else
    # Use environment-specific config (staging, dev, etc.)
    sam deploy --config-env "$ENVIRONMENT" ${stack_params:+--parameter-overrides "$stack_params"}
  fi

  info "Deployment complete!"
}

# --- Print outputs ---
print_outputs() {
  if [ "$ENVIRONMENT" = "--guided" ]; then
    return  # Guided mode prints its own outputs
  fi

  # Determine the stack name based on environment
  local stack_name="mergewatch"
  case "$ENVIRONMENT" in
    staging) stack_name="mergewatch-staging" ;;
    dev)     stack_name="mergewatch-dev" ;;
  esac

  # Fetch and display the webhook URL from CloudFormation outputs
  local webhook_url
  webhook_url=$(aws cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --query 'Stacks[0].Outputs[?OutputKey==`WebhookUrl`].OutputValue' \
    --output text 2>/dev/null || echo "")

  if [ -n "$webhook_url" ]; then
    echo ""
    info "============================================"
    info "  MergeWatch deployed successfully!"
    info "============================================"
    info ""
    info "  Webhook URL: ${webhook_url}"
    info ""
    info "  Add this URL to your GitHub App's webhook settings."
    info "  Content type: application/json"
    info "  Events: Pull requests"
    info ""
    info "============================================"
  fi
}

# --- Main ---
main() {
  echo ""
  info "MergeWatch Deployment"
  info "====================="
  echo ""

  check_prerequisites
  build
  deploy
  print_outputs
}

main
