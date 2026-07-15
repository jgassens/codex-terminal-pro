#!/usr/bin/with-contenv bashio

# Kept as a compatibility entry point for older documentation/bookmarks.
# The add-on image now installs and checksum-verifies the Home Assistant CLI at
# build time, then places its guarded wrapper at /usr/bin/ha.

set -e

bashio::log.info "Home Assistant CLI is already bundled with Codex Terminal Pro."
bashio::log.info "A second persistent copy is intentionally not installed because it could bypass the Supervisor authorization broker."
bashio::log.info "Use 'ha --help' to inspect the bundled command."

/usr/bin/ha --help >/dev/null
