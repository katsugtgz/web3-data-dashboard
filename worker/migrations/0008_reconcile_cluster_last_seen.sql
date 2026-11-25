-- Reconcile any historical clusters whose first_seen/last_seen drifted inside
-- the stored timestamps of their attached posts so queryFeed's c.last_seen >= ?1
-- pre-filter never excludes a cluster with a newer enabled post.
UPDATE clusters
SET first_seen = MIN(
      first_seen,
      COALESCE((SELECT MIN(p.posted_at) FROM posts p WHERE p.cluster_id = clusters.id), first_seen)
    ),
    last_seen = MAX(
      last_seen,
      COALESCE((SELECT MAX(p.posted_at) FROM posts p WHERE p.cluster_id = clusters.id), last_seen)
    )
WHERE EXISTS (
  SELECT 1
  FROM posts p
  WHERE p.cluster_id = clusters.id
    AND (p.posted_at < clusters.first_seen OR p.posted_at > clusters.last_seen)
);
