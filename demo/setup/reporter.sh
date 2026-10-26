#!/usr/bin/env bash
# Starts or stops the live-status reporter: cub sveltos status, as the service
# account chaos-reporter, writing what Sveltos sees into ConfigHub every 15
# seconds. Each pass is a new cub, which renews the reporter's sign-in from its
# key; one long --watch would keep the token cub gave it at the start, and a
# key's sign-in lasts a day.
#
#   source demo/env.sh && bash $DEMO/setup/reporter.sh start|stop|log
set -euo pipefail
[ -n "${AI_CHAOS_DIR:-}" ] && [ -n "${CHAOS_RUNS:-}" ] && [ -n "${DEMO:-}" ] || . "$(cd "$(dirname "$0")/.." && pwd)/env.sh"
: "${AI_CHAOS_DIR:?source demo/env.sh first}"
pid=$AI_CHAOS_DIR/reporter.pid log=$AI_CHAOS_DIR/status-watch.log
# The pid is the loop's bash, whose command line names the status command.
running() { [ -f "$pid" ] && ps -p "$(cat "$pid")" -o command= 2>/dev/null | grep -Eq "sveltos(-confighub)? status --kube-context"; }
case ${1:-start} in
  start)
    if running; then echo "reporter already running ($(cat "$pid"))"; exit 0; fi
    CUB_CONFIG="$AI_CHAOS_DIR/cub/reporter" CUB_CONTEXT=chaos-reporter KUBECONFIG=$AI_CHAOS_DIR/chaos-mgmt.kubeconfig \
      nohup bash -c 'while :; do cub sveltos status --kube-context kind-chaos-mgmt; sleep 15; done' >> "$log" 2>&1 < /dev/null &
    echo $! > "$pid"; echo "reporter started ($(cat "$pid")); log: $log" ;;
  stop) if running; then kill "$(cat "$pid")" && echo "reporter stopped"; else echo "reporter not running"; fi; rm -f "$pid" ;;
  log) tail -n 20 "$log" ;;
esac
