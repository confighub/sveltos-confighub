#!/usr/bin/env bash
# Starts or stops the live-status reporter: cub sveltos status --watch, as the
# worker reporter, writing what Sveltos sees into ConfigHub every 15 seconds.
#
#   source demo/env.sh && bash $DEMO/setup/reporter.sh start|stop|log
set -euo pipefail
: "${AI_CHAOS_DIR:?source demo/env.sh first}"
pid=$AI_CHAOS_DIR/reporter.pid log=$AI_CHAOS_DIR/status-watch.log
running() { [ -f "$pid" ] && ps -p "$(cat "$pid")" -o command= 2>/dev/null | grep -q "status --context kind-chaos-mgmt"; }
case ${1:-start} in
  start)
    if running; then echo "reporter already running ($(cat "$pid"))"; exit 0; fi
    CUB_CONTEXT=chaos-reporter KUBECONFIG=$AI_CHAOS_DIR/chaos-mgmt.kubeconfig \
      nohup cub sveltos status --context kind-chaos-mgmt --watch --interval 15s >> "$log" 2>&1 < /dev/null &
    echo $! > "$pid"; echo "reporter started ($(cat "$pid")); log: $log" ;;
  stop) if running; then kill "$(cat "$pid")" && echo "reporter stopped"; else echo "reporter not running"; fi; rm -f "$pid" ;;
  log) tail -n 20 "$log" ;;
esac
