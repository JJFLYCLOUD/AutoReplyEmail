-- Track failed login attempts by client IP to slow brute-force attacks.
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_reset ON login_attempts(reset_at);
