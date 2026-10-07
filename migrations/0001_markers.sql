-- App-owned annotations, independent of the financial data service.
CREATE TABLE markers (
 id TEXT PRIMARY KEY NOT NULL,
 date TEXT NOT NULL CHECK (length(date) = 10),
 end TEXT CHECK (end IS NULL OR (length(end) = 10 AND end >= date)),
 title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
 revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
CREATE INDEX markers_date ON markers(date, id);

-- Consumed creation identities survive deletion; no deleted content is retained.
CREATE TABLE deleted_marker_ids (id TEXT PRIMARY KEY NOT NULL);
CREATE TRIGGER retain_deleted_marker_id AFTER DELETE ON markers
BEGIN
 INSERT INTO deleted_marker_ids (id) VALUES (OLD.id);
END;
