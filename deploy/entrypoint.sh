#!/bin/sh
# Container entrypoint: check the two things that are silent failures, then run.
#
# Both checks exist because the container defaults differ from the local ones in
# ways that matter. `npm run serve` on a laptop binds to loopback and stores
# nothing; this image binds to 0.0.0.0 and is meant to hold accounts. Neither
# difference announces itself at runtime — an unprotected tracker serves happily
# to whoever finds the port, and a container without a volume looks perfectly
# healthy right up until it is replaced.
set -eu

command="${1:-serve}"

if [ "$command" = "serve" ] || [ "$command" = "dev" ]; then
  if [ -z "${TRACKER_AUTH_TOKEN:-}" ]; then
    cat >&2 <<'MSG'
TRACKER_AUTH_TOKEN is not set.

This container binds to 0.0.0.0, so without a token the tracker API is readable
by anyone who reaches the port. Generate one and pass it in:

    openssl rand -hex 32

Then set TRACKER_AUTH_TOKEN to that value here and on whatever reads this
tracker (TRACKER_UPSTREAM_TOKEN on the Vercel side).
MSG
    exit 1
  fi

  # Long enough not to be guessable in the time a scan takes.
  if [ "${#TRACKER_AUTH_TOKEN}" -lt 24 ]; then
    echo "TRACKER_AUTH_TOKEN is shorter than 24 characters. Use: openssl rand -hex 32" >&2
    exit 1
  fi

  # Storage: redis first, then a data directory, then nothing that survives.
  if [ -z "${KV_REST_API_URL:-}${UPSTASH_REDIS_REST_URL:-}" ]; then
    data_dir="${DATA_DIR:-}"
    if [ -z "$data_dir" ]; then
      echo "WARN  No KV_REST_API_URL and no DATA_DIR: accounts and history will be lost on restart." >&2
    elif [ ! -w "$data_dir" ]; then
      echo "ERROR $data_dir is not writable by this container's user." >&2
      echo "      Fix the volume's ownership: chown -R 1000:1000 <host path>" >&2
      exit 1
    elif ! mountpoint -q "$data_dir" 2>/dev/null && [ -z "${DATA_DIR_UNMOUNTED_OK:-}" ]; then
      # Not fatal — a bind mount does not always register as a mountpoint — but
      # worth saying once, because the failure is invisible until replacement.
      echo "WARN  $data_dir does not look like a mounted volume. If it is not, anything" >&2
      echo "      stored there — including sealed wallet keys — dies with this container." >&2
    fi
  fi
fi

exec node dist/src/cli.js "$@"
