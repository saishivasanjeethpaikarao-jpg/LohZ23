import crypto from "crypto";
import fs from "fs";
import path from "path";

interface EncryptedCredential {
  iv: string;
  encryptedData: string;
  authTag: string;
}
type CredentialFile = Record<string, EncryptedCredential>;

export interface CredentialStoreOptions {
  keyFile?: string;
  credentialsFile?: string;
}

function validProvider(provider: string): boolean {
  return /^[a-z0-9-]{1,32}$/.test(provider);
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

  constructor(opts: CredentialStoreOptions = {}) {
    this.keyFile = path.resolve(opts.keyFile ?? path.join(process.cwd(), ".credential_store_key"));
    this.credentialsFile = path.resolve(opts.credentialsFile ?? path.join(process.cwd(), ".credentials.enc"));
  }

  async init(): Promise<void> {
    if (this.key) return;
    if (!this.initWork) {
      this.initWork = Promise.resolve().then(() => {
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

  async setCredential(provider: string, value: string): Promise<void> {
    this.assertProvider(provider);
    if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 64 * 1024) {
      throw new Error("Credential value is empty or too large");
    }
    await this.enqueue(async () => {
      await this.init();
      const credentials = this.readFile();
      credentials[provider] = encrypt(this.key!, value);
      this.writeFile(credentials);
    });
  }

  async getCredential(provider: string): Promise<string | null> {
    this.assertProvider(provider);
    await this.mutations;
    await this.init();
    const credentials = this.readFile();
    if (provider in credentials) return decrypt(this.key!, credentials[provider]);
    const envVarName = `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
    return process.env[envVarName] ?? null;
  }

  async deleteCredential(provider: string): Promise<void> {
    this.assertProvider(provider);
    await this.enqueue(async () => {
      await this.init();
      const credentials = this.readFile();
      if (!(provider in credentials)) return;
      delete credentials[provider];
      this.writeFile(credentials);
    });
  }

  async hasCredential(provider: string): Promise<boolean> {
    return (await this.getCredential(provider)) !== null;
  }
}

export const credentialStore = new CredentialStore();
