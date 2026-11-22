-- Registry tags (worker/sources.json) become runtime state: persisted so a
-- tags-only edit is a real config change, exposed via /sources.json later.
ALTER TABLE sources ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
