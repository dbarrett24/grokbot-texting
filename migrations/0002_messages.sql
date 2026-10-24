-- Message store. Applied by the Durable Object constructor (migrateMessages).
-- The table starts empty. STORE_MESSAGE_BODIES and CAPTURE_INBOUND default off,
-- so a deploy does not record texts until both the flag and LOG_ENC_KEY are set.
-- Inbound rows are purged after 30 days, outbound after 90.
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY,
  created_ms INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  number_ct TEXT, number_iv TEXT,
  body_ct TEXT, body_iv TEXT,
  last4 TEXT NOT NULL
);
