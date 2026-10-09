#!/usr/bin/env bash
# Resolve the runtime secrets before starting Wrangler. --deploy uploads code
# and its secrets together; otherwise update the existing Worker's secrets.
# Values travel through environment/stdin only, never a file or argument.
set -euo pipefail
op run --env-file=.env.tpl -- bash -euc '
  names=(SOMA_HUB_TOKEN TIINGO_API_KEY)
  for name in "${names[@]}"; do
    value="${!name:-}"
    if [[ -z "$value" || "$value" == CHANGEME || "$value" == op://* || "$value" == *$'"'"'\n'"'"'* ]]; then
      echo "A resolved $name is required" >&2
      exit 1
    fi
  done
  if [[ "${1:-}" == --deploy ]]; then
    shift
    for name in "${names[@]}"; do printf "%s=%s\n" "$name" "${!name}"; done |
      bunx wrangler deploy --secrets-file /dev/stdin "$@"
  else
    for name in "${names[@]}"; do printf "%s" "${!name}" | bunx wrangler secret put "$name" "$@"; done
  fi
' -- "$@"
