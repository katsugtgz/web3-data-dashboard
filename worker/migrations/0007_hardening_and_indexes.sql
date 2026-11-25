DROP INDEX IF EXISTS clusters_ai_backlog;
CREATE INDEX IF NOT EXISTS clusters_ai_backlog
  ON clusters(score DESC, last_seen DESC, ai_retry_after ASC)
  WHERE summary_source = 'rule'
    AND risk_level != 'risk'
    AND ai_attempts < 3
    AND (is_drop IS NULL OR is_drop = 1);
CREATE INDEX IF NOT EXISTS clusters_ticker_lookup
  ON clusters(UPPER(ticker), last_seen DESC, id ASC)
  WHERE ticker IS NOT NULL;
CREATE INDEX IF NOT EXISTS posts_cluster_posted
  ON posts(cluster_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS source_candidates_top
  ON source_candidates(mentions DESC, last_seen DESC, handle ASC)
  WHERE json_array_length(from_sources) >= 2;
