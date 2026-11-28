---
name: Task run contribution
about: Submit validated read-only task run evidence maintainer review
title: '[contribution] '
labels: ['task-contribution', 'needs-review']
assignees: ''
---

Use this template to submit evidence from a read-only task run for maintainer review.

## What to paste

Paste only the sanitized, schema-validated `run_report` JSON. Put it inside the fenced block below and replace the placeholder.

- No secrets, OTPs, cookies, tokens, or seed phrases.
- No personally identifiable information (PII), such as names, email addresses, account handles, or wallet addresses tied to a person.
- No unreviewed URLs.
- Do not submit a fixture report as a live claim.
- Keep the JSON exactly as the validator produced it. Do not edit values by hand.

Leave the reviewer checklist unchecked. The maintainer ticks each item during review.

Issues that break these rules are closed without review.

```json
PASTE THE SANITIZED, SCHEMA-VALIDATED run_report JSON HERE, REPLACING THIS LINE
```

## Reviewer checklist

- [ ] Valid schema v1 & matching revision/ref_sha256
- [ ] No secrets, PII, or unreviewed URLs
- [ ] Official sources verified
- [ ] Fixture report not submitted live claim
