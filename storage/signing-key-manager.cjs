
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const db = require('./database.cjs');
const { encryptBuffer, decryptBuffer } = require('./encryption.cjs');

const KEY_ALIAS = 'android';
const KEY_VALIDITY_DAYS = 10000;

// Locate keytool using Bubblewrap's configured JDK, or PATH.
function findKeytool() {
  const configPath = path.join(os.homedir(), '.bubblewrap', 'config.json');

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    if (config.jdkPath) {
      const executable =
        process.platform === 'win32' ? 'keytool.exe' : 'keytool';

      const configuredPath = path.join(
        config.jdkPath,
        'bin',
        executable
      );

      if (fs.existsSync(configuredPath)) {
        return configuredPath;
      }
    }
  } catch {
    // Fall back to PATH.
  }

  return 'keytool';
}

// Keep distinguished-name values safe for keytool.
function cleanDnPart(value) {
  return String(value || 'WebToApp')
    .replace(/[,=+<>#;"\\\r\n]/g, ' ')
    .trim()
    .slice(0, 60) || 'WebToApp';
}

// Run keytool without exposing passwords in output.
function runKeytool(args, password) {
  const result = spawnSync(findKeytool(), args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000
  });

  if (result.error || result.status !== 0) {
    let message = result.stderr || result.stdout || '';

    if (password) {
      message = message.split(password).join('***');
    }

    throw new Error(
      'Android signing-key operation failed: ' +
      (message.trim() || result.error?.message || 'Unknown keytool error.')
    );
  }

  return result.stdout || '';
}

// Generate a new Android keystore in a temporary directory.
function generateKeystore({ appName, websiteUrl }) {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'webtoapp-signing-')
  );

  const keystorePath = path.join(
    temporaryDirectory,
    'android.keystore'
  );

  const password = crypto.randomBytes(32).toString('base64url');

  const hostname = new URL(websiteUrl).hostname;

  const distinguishedName = [
    `CN=${cleanDnPart(appName)}`,
    'OU=TWA',
    `O=${cleanDnPart(hostname)}`,
    'C=IN'
  ].join(', ');

  try {
    runKeytool([
      '-genkeypair',
      '-keystore', keystorePath,
      '-alias', KEY_ALIAS,
      '-keyalg', 'RSA',
      '-keysize', '2048',
      '-validity', String(KEY_VALIDITY_DAYS),
      '-storepass', password,
      '-keypass', password,
      '-dname', distinguishedName
    ], password);

    const fingerprintOutput = runKeytool([
      '-list',
      '-v',
      '-keystore', keystorePath,
      '-alias', KEY_ALIAS,
      '-storepass', password
    ], password);

    const fingerprintMatch =
      /SHA256:\s*((?:[0-9A-F]{2}:){31}[0-9A-F]{2})/i.exec(
        fingerprintOutput
      );

    if (!fingerprintMatch) {
      throw new Error(
        'Could not retrieve the signing certificate fingerprint.'
      );
    }

    const keystoreBuffer = fs.readFileSync(keystorePath);

    return {
      keystoreBuffer,
      password,
      keyAlias: KEY_ALIAS,
      fingerprint: fingerprintMatch[1].toUpperCase()
    };
  } finally {
    // The encrypted database copy is retained; temporary files are removed.
    fs.rmSync(temporaryDirectory, {
      recursive: true,
      force: true
    });
  }
}

// Create and persist one signing key for an existing project.
function createSigningKey(projectId, options = {}) {
  if (!projectId || typeof projectId !== 'string') {
    throw new Error('A valid project ID is required.');
  }

  const project = db.prepare(`
    SELECT id, website_url, app_name
    FROM projects
    WHERE id = ?
  `).get(projectId);

  if (!project) {
    throw new Error('Project not found.');
  }

  const existingKey = db.prepare(`
    SELECT id, fingerprint
    FROM signing_keys
    WHERE project_id = ?
  `).get(projectId);

  if (existingKey) {
    throw new Error(
      'This project already has a signing key. Existing keys cannot be replaced automatically.'
    );
  }

  const websiteUrl = options.websiteUrl || project.website_url;
  const appName = options.appName || project.app_name || 'WebToApp';

  let parsedUrl;

  try {
    parsedUrl = new URL(websiteUrl);
  } catch {
    throw new Error('The project website URL is invalid.');
  }

  if (parsedUrl.protocol !== 'https:') {
    throw new Error('The project website must use HTTPS.');
  }

  const generated = generateKeystore({
    appName,
    websiteUrl: parsedUrl.href
  });

  // Store the keystore bytes and password together inside one encrypted payload.
  const payload = Buffer.from(JSON.stringify({
    keystoreBase64: generated.keystoreBuffer.toString('base64'),
    password: generated.password,
    keyAlias: generated.keyAlias
  }));

  const encrypted = encryptBuffer(payload);

  const keyId = crypto.randomUUID();

  // A transaction prevents a partially stored signing-key record.
  const insertKey = db.transaction(() => {
    db.prepare(`
      INSERT INTO signing_keys (
        id,
        project_id,
        encrypted_payload,
        encryption_iv,
        authentication_tag,
        key_alias,
        fingerprint
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      keyId,
      projectId,
      encrypted.encryptedPayload,
      encrypted.iv,
      encrypted.authenticationTag,
      generated.keyAlias,
      generated.fingerprint
    );
  });

  insertKey();

  return {
    id: keyId,
    projectId,
    keyAlias: generated.keyAlias,
    fingerprint: generated.fingerprint,
    created: true
  };
}

// Retrieve and decrypt the signing key for an existing project.
function getSigningKey(projectId) {
  if (!projectId || typeof projectId !== 'string') {
    throw new Error('A valid project ID is required.');
  }

  const record = db.prepare(`
    SELECT
      encrypted_payload,
      encryption_iv,
      authentication_tag,
      key_alias,
      fingerprint
    FROM signing_keys
    WHERE project_id = ?
  `).get(projectId);

  if (!record) {
    throw new Error('No signing key exists for this project.');
  }

  const decrypted = decryptBuffer({
    encryptedPayload: record.encrypted_payload,
    iv: record.encryption_iv,
    authenticationTag: record.authentication_tag
  });

  const payload = JSON.parse(decrypted.toString('utf8'));

  if (
    !payload.keystoreBase64 ||
    !payload.password ||
    !payload.keyAlias
  ) {
    throw new Error('Stored signing-key data is incomplete.');
  }

  return {
    keystoreBuffer: Buffer.from(
      payload.keystoreBase64,
      'base64'
    ),
    password: payload.password,
    keyAlias: payload.keyAlias,
    fingerprint: record.fingerprint
  };
}

// Check whether a project already has a signing key.
function hasSigningKey(projectId) {
  return Boolean(
    db.prepare(`
      SELECT 1
      FROM signing_keys
      WHERE project_id = ?
    `).get(projectId)
  );
}

module.exports = {
  createSigningKey,
  getSigningKey,
  hasSigningKey
};
