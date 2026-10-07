#!/usr/bin/env bash
# V2 A12.6.3: validates the LOCAL Prometheus configuration and alert rules with promtool, from the Prometheus image already pinned in
# docker-compose.observability.yml (no other promtool dependency). The container has no network, a read-only root (with a tmpfs /tmp,
# which `promtool test rules` needs) and read-only mounts of the configuration, the rules and their tests:
#   promtool check config  (the scrape configuration and the rule files it loads)
#   promtool check rules   (each rule file, lint findings fatal)
#   promtool test rules    (the synthetic alert tests in infra/observability/prometheus/tests)
# Run by Core CI (repository checks); locally: bash scripts/check-prometheus-rules.sh (needs Docker).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
prom="$root/infra/observability/prometheus"
image="$(sed -nE 's#^    image: (prom/prometheus:[^ @]+@sha256:[0-9a-f]{64})$#\1#p' "$root/docker-compose.observability.yml")"
if [ -z "$image" ] || [ "$(printf '%s\n' "$image" | wc -l)" -ne 1 ]; then
  echo "check-prometheus-rules: no single pinned prom/prometheus image in docker-compose.observability.yml" >&2
  exit 1
fi

shopt -s nullglob
rules=("$prom"/rules/*.rules.yml)
tests=("$prom"/tests/*.test.yml)
if [ "${#rules[@]}" -eq 0 ] || [ "${#tests[@]}" -eq 0 ]; then
  echo "check-prometheus-rules: no rule file or no test file" >&2
  exit 1
fi

promtool() {
  docker run --rm --network none --read-only --tmpfs /tmp \
    -v "$prom/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
    -v "$prom/rules:/etc/prometheus/rules:ro" \
    -v "$prom/tests:/etc/prometheus/tests:ro" \
    --entrypoint promtool "$image" "$@"
}

promtool check config --lint=all --lint-fatal /etc/prometheus/prometheus.yml
promtool check rules --lint=all --lint-fatal "${rules[@]/#$prom//etc/prometheus}"
promtool test rules "${tests[@]/#$prom//etc/prometheus}"
