ALTER TABLE sources ADD COLUMN next_poll_at INTEGER;
ALTER TABLE sources ADD COLUMN first_fail_at INTEGER;

CREATE TABLE IF NOT EXISTS ai_usage (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS source_candidates (
  handle TEXT PRIMARY KEY,
  mentions INTEGER NOT NULL DEFAULT 1,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  from_sources TEXT NOT NULL DEFAULT '[]'
);
