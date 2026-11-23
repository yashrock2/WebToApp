
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDirectory = path.join(__dirname, '..', 'data');
const databasePath = path.join(dataDirectory, 'webtoapp.sqlite');

// Ensure the database directory exists.
fs.mkdirSync(dataDirectory, { recursive: true });

// Open the persistent SQLite database.
const db = new Database(databasePath);

// Database safety and performance settings.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Create database tables.
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    website_url TEXT NOT NULL,
    app_name TEXT,
    package_name TEXT,
    status TEXT NOT NULL DEFAULT 'created',
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS signing_keys (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL UNIQUE,
    encrypted_payload BLOB NOT NULL,
    encryption_iv TEXT NOT NULL,
    authentication_tag TEXT NOT NULL,
    key_alias TEXT NOT NULL,
    fingerprint TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (project_id)
      REFERENCES projects(id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_projects_created_at
  ON projects(created_at);

  CREATE INDEX IF NOT EXISTS idx_projects_status
  ON projects(status);
`);

module.exports = db;
