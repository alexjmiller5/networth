CREATE TABLE widget_devices (
 id TEXT PRIMARY KEY,
 hash TEXT NOT NULL UNIQUE,
 label TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 approved_at INTEGER,
 revoked_at INTEGER
);
