import crypto from "crypto";
import fs from "fs";
import path from "path";
import { runtimePrivateFile } from "./lib/runtimePaths";

interface EncryptedCredential {
  iv: string;
  encryptedData: string;
  authTag: string;
}
type CredentialFile = Record<string, EncryptedCredential>;

export interface CredentialStoreOptions {
  keyFile?: string;
  credentialsFile?: string;
  key?: Buffer;
}

function validProvider(provider: string): boolean {
  return /^[a-z0-9-]{1,32}$/.test(provider);
}

function credentialId(provider: string, userId?: string): string {
  if (!userId) return provider;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error("Invalid credential user identifier");
  return `${userId}:${provider}`;
}

function encrypt(key: Buffer, value: string): EncryptedCredential {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encryptedData = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), encryptedData: encryptedData.toString("base64"), authTag: cipher.getAuthTag().toString("base64") };
}

function decrypt(key: Buffer, value: EncryptedCredential): string {
  if (!value || typeof value.iv !== "string" || typeof value.encryptedData !== "string" || typeof value.authTag !== "string") {
    throw new Error("Credential store record is malformed");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(value.encryptedData, "base64")), decipher.final()]).toString("utf8");
}

export class CredentialStore {
  private key: Buffer | null = null;
  private initWork: Promise<void> | null = null;
  private mutations: Promise<void> = Promise.resolve();
  private readonly keyFile: string;
  private readonly credentialsFile: string;
  private readonly providedKey?: Buffer;

  constructor(opts: CredentialStoreOptions = {}) {
    this.keyFile = path.resolve(opts.keyFile ?? runtimePrivateFile(".credential_store_key"));
    this.credentialsFile = path.resolve(opts.credentialsFile ?? runtimePrivateFile(".credentials.enc"));
    this.providedKey = opts.key ? Buffer.from(opts.key) : undefined;
  }

  async init(): Promise<void> {
    if (this.key) return;
    if (!this.initWork) {
      this.initWork = Promise.resolve().then(() => {
        if (this.providedKey) {
          if (this.providedKey.length !== 32) throw new Error("Credential encryption key must be exactly 32 bytes");
          this.key = Buffer.from(this.providedKey);
          return;
        }
        const envKey = process.env.LOHZ_CREDENTIAL_KEY_B64;
        if (envKey) {
          const key = Buffer.from(envKey, "base64");
          if (key.length !== 32) throw new Error("LOHZ_CREDENTIAL_KEY_B64 must decode to 32 bytes");
          this.key = key;
          return;
        }
        fs.mkdirSync(path.dirname(this.keyFile), { recursive: true });
        let key: Buffer;
        if (fs.existsSync(this.keyFile)) {
          key = fs.readFileSync(this.keyFile);
        } else {
          key = crypto.randomBytes(32);
          try {
            fs.writeFileSync(this.keyFile, key, { flag: "wx", mode: 0o600 });
          } catch (error: any) {
            if (error?.code !== "EEXIST") throw error;
            key = fs.readFileSync(this.keyFile);
          }
        }
        if (key.length !== 32) throw new Error("Credential encryption key must be exactly 32 bytes");
        try { fs.chmodSync(this.keyFile, 0o600); } catch { /* Windows ACLs differ */ }
        this.key = key;
      }).finally(() => { this.initWork = null; });
    }
    await this.initWork;
  }

  private assertProvider(provider: string): void {
    if (!validProvider(provider)) throw new Error("Invalid credential provider identifier");
  }

  private readFile(): CredentialFile {
    if (!fs.existsSync(this.credentialsFile)) return {};
    const parsed = JSON.parse(fs.readFileSync(this.credentialsFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Credential store is malformed");
    return parsed as CredentialFile;
  }

  private writeFile(credentials: CredentialFile): void {
    fs.mkdirSync(path.dirname(this.credentialsFile), { recursive: true });
    const temp = `${this.credentialsFile}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(credentials, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
      fs.renameSync(temp, this.credentialsFile);
      try { fs.chmodSync(this.credentialsFile, 0o600); } catch { /* Windows ACLs differ */ }
    } finally {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort */ }
    }
  }

  private enqueue<T>(fn: () => Promise<T> | T): Promise<T> {
    const work = this.mutations.then(fn, fn);
    this.mutations = work.then(() => undefined, () => undefined);
    return work;
  }

  async setCredential(provider: string, value: string, userId?: string): Promise<void> {
    this.assertProvider(provider);
    if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 64 * 1024) {
      throw new Error("Credential value is empty or too large");
    }
    await this.enqueue(async () => {
      await this.init();
      const credentials = this.readFile();
      credentials[credentialId(provider, userId)] = encrypt(this.key!, value);
      this.writeFile(credentials);
    });
  }

  async getCredential(provider: string, userId?: string): Promise<string | null> {
    this.assertProvider(provider);
    await this.mutations;
    await this.init();
    const credentials = this.readFile();
    if (userId) {
      const userSpecificId = credentialId(provider, userId);
      if (userSpecificId in credentials) return decrypt(this.key!, credentials[userSpecificId]);
    }
    // Fallback 1: global credential without userId
    if (provider in credentials) return decrypt(this.key!, credentials[provider]);
    // Fallback 2: environment variables (e.g. GEMINI_API_KEY, VITE_GEMINI_API_KEY)
    const envVarName = `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
    return process.env[envVarName] ?? process.env[`VITE_${envVarName}`] ?? null;
  }

  async deleteCredential(provider: string, userId?: string): Promise<void> {
    this.assertProvider(provider);
    await this.enqueue(async () => {
      await this.init();
      const credentials = this.readFile();
      const id = credentialId(provider, userId);
      if (!(id in credentials)) return;
      delete credentials[id];
      this.writeFile(credentials);
    });
  }

  async hasCredential(provider: string, userId?: string): Promise<boolean> {
    return (await this.getCredential(provider, userId)) !== null;
  }
}

export const credentialStore = new CredentialStore();
