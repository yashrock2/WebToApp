
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load the encryption secret from the root .env file.
const envPath = path.join(__dirname, '..', '.env');

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');

  for (const line of envContent.split(/\r?\n/)) {
    const match = line.match(
      /^\s*WEBTOAPP_KEY_ENCRYPTION_SECRET\s*=\s*(.*?)\s*$/
    );

    if (match && !process.env.WEBTOAPP_KEY_ENCRYPTION_SECRET) {
      process.env.WEBTOAPP_KEY_ENCRYPTION_SECRET =
        match[1].replace(/^["']|["']$/g, '');
    }
  }
}

const db = require('./database.cjs');

const {
  createSigningKey,
  getSigningKey,
  hasSigningKey
} = require('./signing-key-manager.cjs');

const projectId = crypto.randomUUID();

try {
  console.log('\n1. Creating a temporary test project...');

  db.prepare(`
    INSERT INTO projects (
      id,
      website_url,
      app_name,
      status,
      config_json
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(
    projectId,
    'https://example.com',
    'WebToApp Test',
    'created',
    '{}'
  );

  console.log('Test project created.');

  console.log('\n2. Generating and storing signing key...');

  const created = createSigningKey(projectId);

  if (!created.created || !created.fingerprint) {
    throw new Error('Signing key generation failed.');
  }

  console.log('Signing key generated and stored.');
  console.log('Fingerprint:', created.fingerprint);

  console.log('\n3. Checking stored signing key...');

  if (!hasSigningKey(projectId)) {
    throw new Error('Signing key was not found in the database.');
  }

  console.log('Signing key exists in database.');

  console.log('\n4. Retrieving and decrypting signing key...');

  const retrieved = getSigningKey(projectId);

  if (!Buffer.isBuffer(retrieved.keystoreBuffer)) {
    throw new Error('Retrieved keystore is not a Buffer.');
  }

  if (retrieved.keystoreBuffer.length === 0) {
    throw new Error('Retrieved keystore is empty.');
  }

  if (!retrieved.password || !retrieved.keyAlias) {
    throw new Error('Retrieved signing-key credentials are incomplete.');
  }

  if (retrieved.fingerprint !== created.fingerprint) {
    throw new Error('Fingerprint does not match.');
  }

  console.log('Signing key decrypted successfully.');
  console.log('Keystore size:', retrieved.keystoreBuffer.length, 'bytes.');
  console.log('Fingerprint matches.');

  console.log('\n5. Checking duplicate-key protection...');

  let duplicateBlocked = false;

  try {
    createSigningKey(projectId);
  } catch (error) {
    duplicateBlocked = error.message.includes('already has a signing key');
  }

  if (!duplicateBlocked) {
    throw new Error('Duplicate signing-key protection failed.');
  }

  console.log('Duplicate key generation correctly blocked.');

  console.log('\nALL SIGNING-KEY TESTS PASSED.');
} finally {
  // Remove the temporary project and its signing key.
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

  console.log('\nTemporary test project cleaned up.');

  db.close();
}
