#!/usr/bin/env bash
# Resolve the runtime secret before starting Wrangler. --deploy uploads code
# and its secret together; otherwise update the existing Worker's secret.
# Values travel through environment/stdin only, never a file or argument.
set -euo pipefail
op run --env-file=.env.tpl -- bash -euc '
  if [[ -z "${LIFE_HUB_TOKEN:-}" || "$LIFE_HUB_TOKEN" == CHANGEME || "$LIFE_HUB_TOKEN" == op://* || "$LIFE_HUB_TOKEN" == *$'"'"'\n'"'"'* ]]; then
    echo "A resolved LIFE_HUB_TOKEN is required" >&2
    exit 1
  fi
  if [[ "${1:-}" == --deploy ]]; then
    shift
    printf "LIFE_HUB_TOKEN=%s\n" "$LIFE_HUB_TOKEN" | bunx wrangler deploy --secrets-file /dev/stdin "$@"
  else
    printf "%s" "$LIFE_HUB_TOKEN" | bunx wrangler secret put LIFE_HUB_TOKEN "$@"
  fi
' -- "$@"
