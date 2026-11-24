ALTER TABLE clusters ADD COLUMN trust_max REAL NOT NULL DEFAULT 0.5;
UPDATE clusters
SET trust_max = COALESCE(
  (SELECT MAX(s.trust)
   FROM posts p
   JOIN sources s ON s.id = p.source_id
   WHERE p.cluster_id = clusters.id),
  0.5
);
ALTER TABLE clusters ADD COLUMN ai_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clusters ADD COLUMN ai_retry_after INTEGER NOT NULL DEFAULT 0;
DROP INDEX IF EXISTS clusters_score;
CREATE INDEX IF NOT EXISTS clusters_ai_backlog
  ON clusters(score DESC, last_seen DESC)
  WHERE summary_source = 'rule' AND risk_level != 'risk' AND ai_attempts < 3;
CREATE INDEX IF NOT EXISTS clusters_feed_score
  ON clusters(score DESC, last_seen DESC, id ASC);
CREATE INDEX IF NOT EXISTS clusters_feed_new
  ON clusters(last_seen DESC, score DESC, id ASC);
CREATE INDEX IF NOT EXISTS sources_poll
  ON sources(platform, enabled, last_polled_at ASC);
CREATE TABLE IF NOT EXISTS cron_state (
  key TEXT PRIMARY KEY,
  last_run_at INTEGER NOT NULL
);
