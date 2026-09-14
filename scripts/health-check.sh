#!/usr/bin/env bash
# Probe every SYNTRIX service. This is the M0' acceptance script — see docs/ACCEPTANCE.md.
#
# Usage:  bash scripts/health-check.sh [--host localhost] [--profiles "kicad search"]
#
# Only the four required services are checked by default; a profile's services are added
# with --profiles. Exits non-zero if any checked service is unreachable, so CI can gate
# on it.

set -uo pipefail

HOST="${HOST:-localhost}"
PROFILES="${PROFILES:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --profiles) PROFILES="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# name:port:path — the public proxy plus every required service's own health endpoint.
# Mongo has no HTTP endpoint; the api reports it as a dependency in /health.
CHECKS=(
  "proxy:3015:/api/health"
  "web:3016:/health"
  "api:3017:/health"
)

# Profile services, added only when the caller says that profile is up.
for profile in $PROFILES; do
  case "$profile" in
    kicad)    CHECKS+=("kicad:3019:/health") ;;
    search)   CHECKS+=("meilisearch:7700:/health") ;;
    indexing) CHECKS+=("worker:3023:/health") ;;
    *) echo "unknown profile: $profile" >&2; exit 2 ;;
  esac
done

GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'

failed=0
printf "%-14s %-8s %-10s %s\n" "SERVICE" "PORT" "STATUS" "DETAIL"
printf '%s\n' "$(printf '─%.0s' {1..64})"

for entry in "${CHECKS[@]}"; do
  IFS=: read -r name port path <<< "$entry"
  url="http://${HOST}:${port}${path}"

  # Separate the body from the status code in one request.
  response=$(curl -fsS -m 5 -w '\n%{http_code}' "$url" 2>/dev/null)
  code=$(printf '%s' "$response" | tail -n1)
  body=$(printf '%s' "$response" | sed '$d')

  if [[ "$code" == "200" ]]; then
    # Surface the reported status, since a service can answer 200 while degraded.
    reported=$(printf '%s' "$body" | grep -o '"status"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
    reported="${reported:-ok}"
    if [[ "$reported" == "ok" ]]; then
      printf "%-14s %-8s ${GREEN}%-10s${RESET} %s\n" "$name" "$port" "up" ""
    else
      printf "%-14s %-8s ${YELLOW}%-10s${RESET} %s\n" "$name" "$port" "$reported" "${DIM}reachable, not fully healthy${RESET}"
    fi
  else
    printf "%-14s %-8s ${RED}%-10s${RESET} %s\n" "$name" "$port" "down" "${DIM}no response on ${url}${RESET}"
    failed=$((failed + 1))
  fi
done

printf '%s\n' "$(printf '─%.0s' {1..64})"
if [[ $failed -eq 0 ]]; then
  printf "${GREEN}All services responding.${RESET}\n"
  exit 0
fi

printf "${RED}%d service(s) unreachable.${RESET} Try: make logs\n" "$failed"
exit 1
