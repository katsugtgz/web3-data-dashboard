ALTER TABLE clusters ADD COLUMN is_drop INTEGER;
ALTER TABLE clusters ADD COLUMN project_key TEXT;
WITH RECURSIVE norm_project(id, rest, acc) AS (
  SELECT id, lower(project), ''
  FROM clusters
  WHERE domain IS NULL AND project_key IS NULL
  UNION ALL
  SELECT
    id,
    substr(rest, 2),
    acc || CASE WHEN substr(rest, 1, 1) GLOB '[a-z0-9]' THEN substr(rest, 1, 1) ELSE '' END
  FROM norm_project
  WHERE length(rest) > 0
)
UPDATE clusters
SET project_key = (
  SELECT NULLIF(acc, '')
  FROM norm_project
  WHERE norm_project.id = clusters.id AND length(norm_project.rest) = 0
)
WHERE domain IS NULL AND project_key IS NULL;
CREATE INDEX IF NOT EXISTS clusters_fallback_project
  ON clusters(project_key, last_seen DESC, id ASC)
  WHERE domain IS NULL AND project_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS fallback_windows (
  identity_key TEXT PRIMARY KEY,
  cluster_id   TEXT NOT NULL,
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL
);
