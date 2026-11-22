/**
 * Shared test helpers.
 *
 * FORBIDDEN_CJK_RE must stay in sync with scripts/check-no-cjk.sh, which
 * gates CI: Han + Hiragana + Katakana + Hangul + Bopomofo plus the CJK
 * punctuation/compat ranges U+3000–303F and U+FF01–FF9F.
 */
export const FORBIDDEN_CJK_RE =
  /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Bopomofo}|[\u3000-\u303F\uFF01-\uFF9F]/u;
