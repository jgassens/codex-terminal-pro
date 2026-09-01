#!/usr/bin/env bash

# Shared lexical validation for Supervisor request paths. Callers retain their
# own public contracts and authorization decisions; this helper only returns
# one unambiguous route (without query) or fails.
normalize_supervisor_path() {
    local candidate="${1:-}"
    local route
    local lowered

    case "$candidate" in
        http://supervisor/*) candidate="/${candidate#http://supervisor/}" ;;
    esac
    case "$candidate" in
        /*) ;;
        *) return 1 ;;
    esac
    case "$candidate" in
        *$'\r'*|*$'\n'*|*'#'*) return 1 ;;
    esac

    route="${candidate%%\?*}"
    case "$route" in
        *\\*|*//*|*/.|*/..) return 1 ;;
        */) [ "$route" = "/" ] || return 1 ;;
    esac
    case "/${route#/}/" in
        */./*|*/../*) return 1 ;;
    esac
    lowered="$(printf '%s' "$route" | tr '[:upper:]' '[:lower:]')"
    case "$lowered" in
        *%2e*|*%2f*|*%5c*|*%25*) return 1 ;;
    esac

    printf '%s\n' "$route"
}
