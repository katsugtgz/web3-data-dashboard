-- Persist ingest-time drop relevance verdict so queryFeed trusts verified drops
-- without re-classifying truncated rule summaries.
-- NULL = legacy pre-migration row; 1 = verified drop; 0 = non-drop.
ALTER TABLE clusters ADD COLUMN is_drop INTEGER;
CREATE INDEX IF NOT EXISTS clusters_last_seen ON clusters(last_seen DESC, score DESC, id ASC);
