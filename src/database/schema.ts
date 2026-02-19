/**
 * Database Schema
 *
 * Single authoritative location for schema version and table definitions.
 * No migrations — if version mismatches, wipe and recreate from phone sync.
 */

export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
  thread_id INTEGER PRIMARY KEY,
  addresses TEXT NOT NULL,
  snippet TEXT,
  date INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 1,
  unread_count INTEGER NOT NULL DEFAULT 0,
  locally_read_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_conversations_date ON conversations(date DESC);

CREATE TABLE IF NOT EXISTS messages (
  _id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  body TEXT,
  date INTEGER NOT NULL,
  type INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  sub_id INTEGER NOT NULL DEFAULT 0,
  event INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date);

CREATE TABLE IF NOT EXISTS attachments (
  part_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  unique_identifier INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  filename TEXT,
  file_size INTEGER,
  downloaded INTEGER NOT NULL DEFAULT 0,
  local_path TEXT,
  thumbnail_path TEXT,
  PRIMARY KEY (part_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);

CREATE TABLE IF NOT EXISTS contacts (
  uid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone_numbers TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  app_name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  time INTEGER NOT NULL,
  dismissable INTEGER NOT NULL DEFAULT 0,
  silent INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notifications_time ON notifications(time DESC);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;
