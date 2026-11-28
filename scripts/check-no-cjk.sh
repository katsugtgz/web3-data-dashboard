#!/usr/bin/env bash
set -euo pipefail

# Full CJK coverage: Han + Hiragana + Katakana + Hangul + Bopomofo plus CJK
# symbols/punctuation, enclosed ideographs, compatibility forms, and fullwidth
# forms (e.g. U+FFE5, U+3231, U+FE30).
CJK_RE='\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Bopomofo}|[\x{3000}-\x{303F}\x{3200}-\x{32FF}\x{FE30}-\x{FE4F}\x{FF01}-\x{FFEF}]'

set +e
MATCHES=$(rg -n --pcre2 "$CJK_RE" src shared worker/src server deploy index.html scripts public worker/sources.json worker/migrations data/snapshot data/tasks skills .github --glob '!worker/src/normalize/i18n.ts')
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
