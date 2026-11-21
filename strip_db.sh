#!/bin/bash
# Delete WaveformQuality rows older than N days from the SeisComP database,
# in small batches, together with their matching Object rows.
#
# Usage:  bash strip_db.sh [days]            default: 7
# Credentials are read from ~/.my.cnf (or set MYSQL_OPTS, e.g.
#   MYSQL_OPTS="-u sysop -p" bash strip_db.sh 7   to be prompted).
# Database name defaults to "seiscomp"; override with SC_DB=...
#
# Run inside tmux/screen so Ctrl+Z can't strand a live DB transaction.
#
# Only rows whose _oid belongs to an old WaveformQuality are touched.
# The SeisComP schema has no ON DELETE CASCADE, so each batch deletes the
# WaveformQuality row and its Object row explicitly, by _oid.

set -euo pipefail

DAYS=${1:-7}
SC_DB=${SC_DB:-seiscomp}
BATCH_SIZE=${BATCH_SIZE:-10000}
CUTOFF=$(date -u -d "${DAYS} days ago" '+%Y-%m-%d %H:%M:%S')
# shellcheck disable=SC2086
DB() { mysql ${MYSQL_OPTS:-} -N -B "$SC_DB" -e "$1"; }

echo "Stripping WaveformQuality records with end < $CUTOFF  (keeping last $DAYS days)"
echo "Database: $SC_DB    batch size: $BATCH_SIZE"
echo "Started:  $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo

BATCH=0
TOTAL=0

while true; do
    # Collect one batch of _oids into a temp table, then delete exactly those
    # rows from WaveformQuality and Object in one transaction.
    N=$(DB "
        CREATE TEMPORARY TABLE _strip_oids (_oid BIGINT PRIMARY KEY);
        INSERT INTO _strip_oids
            SELECT _oid FROM WaveformQuality WHERE end < '$CUTOFF' LIMIT $BATCH_SIZE;
        START TRANSACTION;
        DELETE w FROM WaveformQuality w JOIN _strip_oids t ON t._oid = w._oid;
        DELETE o FROM Object o          JOIN _strip_oids t ON t._oid = o._oid;
        COMMIT;
        SELECT COUNT(*) FROM _strip_oids;
    " | tail -1)

    N=${N:-0}
    BATCH=$((BATCH + 1))
    TOTAL=$((TOTAL + N))
    printf "[%s] batch %4d: %6d rows deleted  (running total: %d)\n" \
        "$(date -u '+%H:%M:%S')" "$BATCH" "$N" "$TOTAL"

    [ "$N" -eq 0 ] && break
    sleep 0.1   # small pause — keeps DB responsive
done

echo
echo "Finished: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "WaveformQuality (+ Object) rows deleted: $TOTAL"
echo
echo "To reclaim disk space, run:"
echo "  mysql ${MYSQL_OPTS:-} $SC_DB -e 'OPTIMIZE TABLE WaveformQuality, Object;'"
