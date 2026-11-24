CREATE TABLE wizard_prefs (
  id INTEGER PRIMARY KEY,
  skip_welcome INTEGER NOT NULL DEFAULT 0,
  skip_key_check INTEGER NOT NULL DEFAULT 0,
  confirmed_recipient_hash TEXT,
  confirmed_build_fingerprint TEXT,
  completions INTEGER NOT NULL DEFAULT 0,
  last_key_check_at INTEGER
);
