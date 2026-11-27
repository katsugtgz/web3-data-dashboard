-- Rich structured drop metadata and cached domain/OG/logo enrichment table.
ALTER TABLE clusters ADD COLUMN reward_pool TEXT;
ALTER TABLE clusters ADD COLUMN deadline TEXT;
ALTER TABLE clusters ADD COLUMN deadline_updated_at INTEGER;
ALTER TABLE clusters ADD COLUMN cost TEXT;
ALTER TABLE clusters ADD COLUMN steps TEXT;
ALTER TABLE clusters ADD COLUMN og_image TEXT;
ALTER TABLE clusters ADD COLUMN og_title TEXT;
ALTER TABLE clusters ADD COLUMN og_description TEXT;
ALTER TABLE clusters ADD COLUMN tvl_usd REAL;
ALTER TABLE clusters ADD COLUMN funding TEXT;
ALTER TABLE clusters ADD COLUMN radar_id TEXT;

CREATE TABLE IF NOT EXISTS domain_meta (
  domain TEXT PRIMARY KEY,
  logo_url TEXT,
  og_image TEXT,
  og_title TEXT,
  og_description TEXT,
  tvl_usd REAL,
  category TEXT,
  source TEXT NOT NULL DEFAULT 'html',
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS domain_meta_expires ON domain_meta(expires_at);
