#!/bin/bash
# Copy environment from a running SeisComP process (scmaster) so all
# custom vars like SHORT_HOST_NAME, SEISCOMP_HOME_FOLDER etc. are set
SC_PID=$(pgrep -f "scmaster" | head -1)
if [ -n "$SC_PID" ]; then
    while IFS= read -r -d '' var; do
        export "$var" 2>/dev/null || true
    done < /proc/$SC_PID/environ
fi
exec python3 /opt/seiscomp/var/run/qclog2/backend.py "$@"
