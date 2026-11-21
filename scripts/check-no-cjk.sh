#!/usr/bin/env bash
set -euo pipefail

set +e
MATCHES=$(rg -n --pcre2 '\p{Script=Han}' src shared worker/src index.html --glob '!worker/src/normalize/i18n.ts')
STATUS=$?
set -e

if [ "$STATUS" -eq 0 ]; then
  echo "ERROR: Found forbidden CJK characters outside worker/src/normalize/i18n.ts:"
  echo "$MATCHES"
  exit 1
elif [ "$STATUS" -eq 1 ]; then
  echo "OK: Zero forbidden CJK characters found."
  exit 0
else
  echo "ERROR: ripgrep failed with exit code $STATUS"
  exit "$STATUS"
fi

