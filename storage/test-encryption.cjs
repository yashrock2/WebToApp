const fs = require('fs');
const path = require('path');

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

const {
  encryptBuffer,
  decryptBuffer
} = require('./encryption.cjs');

// Original test data.
const original = Buffer.from('WebToApp signing key test');

// Encrypt the data.
const encrypted = encryptBuffer(original);

// Decrypt the data.
const decrypted = decryptBuffer(encrypted);

// Verify the results.
if (!original.equals(decrypted)) {
  throw new Error('Encryption round-trip test failed.');
}

if (encrypted.encryptedPayload.equals(original)) {
  throw new Error('Encrypted data matches plaintext.');
}

console.log('Encryption successful.');
console.log('Decryption successful.');
console.log('Encrypted data differs from original data.');
