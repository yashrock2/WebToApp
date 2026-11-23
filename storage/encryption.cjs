
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

// Encryption secret must be exactly 32 bytes represented as 64 hex characters.
function getEncryptionKey() {
  const secret = process.env.WEBTOAPP_KEY_ENCRYPTION_SECRET;

  if (!secret || !/^[0-9a-fA-F]{64}$/.test(secret)) {
    throw new Error(
      'WEBTOAPP_KEY_ENCRYPTION_SECRET must contain exactly 64 hexadecimal characters.'
    );
  }

  return Buffer.from(secret, 'hex');
}

function encryptBuffer(input) {
  if (!Buffer.isBuffer(input)) {
    throw new TypeError('Encryption input must be a Buffer.');
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(input),
    cipher.final()
  ]);

  const authenticationTag = cipher.getAuthTag();

  return {
    encryptedPayload: encrypted,
    iv: iv.toString('hex'),
    authenticationTag: authenticationTag.toString('hex')
  };
}

function decryptBuffer({
  encryptedPayload,
  iv,
  authenticationTag
}) {
  if (!Buffer.isBuffer(encryptedPayload)) {
    throw new TypeError('Encrypted payload must be a Buffer.');
  }

  if (!/^[0-9a-fA-F]{24}$/.test(iv || '')) {
    throw new Error('Invalid encryption IV.');
  }

  if (!/^[0-9a-fA-F]{32}$/.test(authenticationTag || '')) {
    throw new Error('Invalid authentication tag.');
  }

  const key = getEncryptionKey();

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, 'hex')
  );

  decipher.setAuthTag(Buffer.from(authenticationTag, 'hex'));

  return Buffer.concat([
    decipher.update(encryptedPayload),
    decipher.final()
  ]);
}

module.exports = {
  encryptBuffer,
  decryptBuffer
};
