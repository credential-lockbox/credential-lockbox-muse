DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE saved_blobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  blob TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'staged',
  created_at INTEGER NOT NULL
);
