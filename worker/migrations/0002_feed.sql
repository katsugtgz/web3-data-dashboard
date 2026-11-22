CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  handle TEXT NOT NULL,
  lang TEXT,
  trust REAL NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_seen_id TEXT,
  last_ok_at INTEGER,
  last_polled_at INTEGER,
  status TEXT NOT NULL DEFAULT 'ok',
  fail_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  post_url TEXT NOT NULL,
  posted_at INTEGER NOT NULL,
  text TEXT NOT NULL,
  urls TEXT NOT NULL,
  forwarded_from TEXT,
  cluster_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_cluster ON posts(cluster_id);
CREATE INDEX IF NOT EXISTS posts_posted ON posts(posted_at);

CREATE TABLE IF NOT EXISTS clusters (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  ticker TEXT,
  domain TEXT,
  chains TEXT NOT NULL,
  task_types TEXT NOT NULL,
  summary TEXT NOT NULL,
  summary_source TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  risk_reasons TEXT NOT NULL,
  score REAL NOT NULL,
  source_count INTEGER NOT NULL,
  surf_tier TEXT,
  surf_rank INTEGER,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS clusters_score ON clusters(score DESC);

CREATE TABLE IF NOT EXISTS known_domains (
  domain TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  origin TEXT NOT NULL
);
