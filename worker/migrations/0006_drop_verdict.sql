ALTER TABLE clusters ADD COLUMN is_drop INTEGER;
ALTER TABLE clusters ADD COLUMN project_key TEXT;
UPDATE clusters
SET project_key = lower(replace(replace(replace(replace(replace(replace(project, ' ', ''), '-', ''), '_', ''), '.', ''), ':', ''), '/', ''))
WHERE domain IS NULL AND project_key IS NULL;
CREATE INDEX IF NOT EXISTS clusters_fallback_project
  ON clusters(project_key, last_seen DESC, id ASC)
  WHERE domain IS NULL AND project_key IS NOT NULL;
