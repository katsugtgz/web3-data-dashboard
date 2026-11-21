#!/usr/bin/env bash
set -euo pipefail

# Full CJK coverage: Han + Hiragana + Katakana + Hangul. Han-only matching let
# Japanese/Korean text through a gate that claims to reject CJK.
CJK_RE='\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Bopomofo}|[\x{3000}-\x{303F}\x{FF01}-\x{FF9F}]'

set +e
MATCHES=$(rg -n --pcre2 "$CJK_RE" src shared worker/src index.html --glob '!worker/src/normalize/i18n.ts')
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

