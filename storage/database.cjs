'use strict';

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

// Create or upgrade the database schema.
// IF NOT EXISTS preserves existing project and signing-key records.
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

  CREATE TABLE IF NOT EXISTS builds (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    options_json TEXT NOT NULL DEFAULT '{}',
    log_json TEXT NOT NULL DEFAULT '[]',
    files_json TEXT NOT NULL DEFAULT '[]',
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT,

    FOREIGN KEY (project_id)
      REFERENCES projects(id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_projects_created_at
    ON projects(created_at);

  CREATE INDEX IF NOT EXISTS idx_projects_status
    ON projects(status);

  CREATE INDEX IF NOT EXISTS idx_builds_project_created
    ON builds(project_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_builds_status_created
    ON builds(status, created_at);
`);

module.exports = db;
