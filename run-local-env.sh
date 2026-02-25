#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.local}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE"
  echo "Create it from: $ROOT_DIR/.env.local.example"
  exit 1
fi

(
  cd "$ROOT_DIR"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a

  echo "Using local env file: $ENV_FILE"
  echo "OPENAI_BASE_URL=${OPENAI_BASE_URL:-<unset>}"
  exec bash "$ROOT_DIR/run.sh"
)

