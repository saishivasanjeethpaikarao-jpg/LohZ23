import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Encryption key file and credentials file
const KEY_FILE = path.resolve(process.cwd(), '.credential_store_key');
const CREDENTIALS_FILE = path.resolve(process.cwd(), '.credentials.enc');

/**
 * Generates a random 256-bit encryption key and stores it in KEY_FILE.
 * If the key file already exists, it is read and returned.
 * @returns {Promise<Buffer>} The encryption key as a Buffer.
 */
async function getOrCreateEncryptionKey(): Promise<Buffer> {
  if (fs.existsSync(KEY_FILE)) {
    const keyData = fs.readFileSync(KEY_FILE);
    return keyData;
  } else {
    const key = crypto.randomBytes(32); // 256-bit key
    fs.writeFileSync(KEY_FILE, key, { encoding: 'binary' });
    return key;
  }
}

/**
 * Encrypts a value using AES-256-GCM with a random IV.
 * @param {Buffer} key - The encryption key (32 bytes).
 * @param {string} value - The value to encrypt.
 * @returns {{ iv: Buffer; encryptedData: Buffer; authTag: Buffer }} The encrypted data.
 */
function encrypt(key: Buffer, value: string): { iv: Buffer; encryptedData: Buffer; authTag: Buffer } {
  const iv = crypto.randomBytes(12); // GCM recommended IV length
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encryptedData = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { iv, encryptedData, authTag };
}

/**
 * Decrypts a value using AES-256-GCM.
 * @param {Buffer} key - The encryption key (32 bytes).
 * @param {Buffer} iv - The initialization vector (12 bytes).
 * @param {Buffer} encryptedData - The encrypted data.
 * @param {Buffer} authTag - The authentication tag.
 * @returns {string} The decrypted value.
 */
function decrypt(key: Buffer, iv: Buffer, encryptedData: Buffer, authTag: Buffer): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  return decrypted.toString('utf8');
}

export class CredentialStore {
  private key: Buffer | null = null;

  async init(): Promise<void> {
    if (this.key) return;
    this.key = await getOrCreateEncryptionKey();
  }

/**
   * Stores a credential for the given provider.
   * @param {string} provider - The provider identifier (e.g., 'gemini').
   * @param {string} value - The credential value (e.g., API key).
   * @returns {Promise<void>}
   */
  async setCredential(provider: string, value: string): Promise<void> {
    await this.init();
    const { iv, encryptedData, authTag } = encrypt(this.key, value);
    // Read existing credentials
    // JSON file stores everything as base64 strings
    let credentials: { [provider: string]: { iv: string; encryptedData: string; authTag: string } } = {};
    if (fs.existsSync(CREDENTIALS_FILE)) {
      const data = fs.readFileSync(CREDENTIALS_FILE);
      credentials = JSON.parse(data.toString());
    }
    // Store the new credential (already in base64 string format)
    credentials[provider] = {
      iv: iv.toString('base64'),
      encryptedData: encryptedData.toString('base64'),
      authTag: authTag.toString('base64')
    };
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2));
  }

  /**
   * Retrieves a credential for the given provider.
   * First checks the secure store, then falls back to environment variable.
   * @param {string} provider - The provider identifier (e.g., 'gemini').
   * @returns {Promise<string | null>} The credential value or null if not found.
   */
  async getCredential(provider: string): Promise<string | null> {
    await this.init();
    // Check secure store
    if (fs.existsSync(CREDENTIALS_FILE)) {
      const data = fs.readFileSync(CREDENTIALS_FILE);
      let credentials: { [provider: string]: { iv: string; encryptedData: string; authTag: string } } = {};
      try {
        credentials = JSON.parse(data.toString());
      } catch (e) {
        // If the file is corrupt, we treat as empty
        credentials = {};
      }
      if (provider in credentials) {
        const cred = credentials[provider];
        try {
          const decrypted = decrypt(
            this.key,
            Buffer.from(cred.iv, 'base64'),
            Buffer.from(cred.encryptedData, 'base64'),
            Buffer.from(cred.authTag, 'base64')
          );
          return decrypted;
        } catch (e) {
          // If decryption fails, we treat as missing
          return null;
        }
      }
    }
    // Fallback to environment variable
    // Convert provider ID to environment variable name: provider in uppercase, replace hyphens with underscores, append _API_KEY
    const envVarName = `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`;
    const envValue = process.env[envVarName];
    if (envValue !== undefined && envValue !== null) {
      return envValue;
    }
    return null;
  }

  /**
   * Deletes a credential for the given provider.
   * @param {string} provider - The provider identifier (e.g., 'gemini').
   * @returns {Promise<void>}
   */
  async deleteCredential(provider: string): Promise<void> {
    await this.init();
    if (!fs.existsSync(CREDENTIALS_FILE)) {
      return;
    }
    const data = fs.readFileSync(CREDENTIALS_FILE);
    let credentials: { [provider: string]: { iv: string; encryptedData: string; authTag: string } } = {};
    try {
      credentials = JSON.parse(data.toString());
    } catch (e) {
      // If the file is corrupt, we treat as empty
      credentials = {};
    }
    delete credentials[provider];
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2));
  }

  /**
   * Checks if a credential exists for the given provider (either in secure store or environment variable).
   * @param {string} provider - The provider identifier (e.g., 'gemini').
   * @returns {Promise<boolean>} True if the credential exists, false otherwise.
   */
  async hasCredential(provider: string): Promise<boolean> {
    const cred = await this.getCredential(provider);
    return cred !== null;
  }
}

// We'll export a singleton instance
export const credentialStore = new CredentialStore();