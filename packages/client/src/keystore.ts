import { generateKeyPair, getPublicKey, sign as edSign } from "@remi/crypto";

const DB_NAME = "remi-keystore";
const STORE_NAME = "keys";
const KEY = "privateKey";

export class KeyStore {
  private privateKey: string | null = null;
  private publicKey: string | null = null;
  private ephemeral = false;

  async init(): Promise<void> {
    const stored = await this.loadFromStorage();
    if (stored) {
      this.privateKey = stored;
    } else {
      this.privateKey = generateKeyPair();
      await this.saveToStorage(this.privateKey);
    }
    this.publicKey = getPublicKey(this.privateKey);
  }

  getPublicKey(): string {
    if (!this.publicKey) throw new Error("KeyStore not initialized");
    return this.publicKey;
  }

  async sign(data: Uint8Array): Promise<string> {
    if (!this.privateKey) throw new Error("KeyStore not initialized");
    return edSign(data, this.privateKey);
  }

  exportPrivateKey(): string {
    if (!this.privateKey) throw new Error("KeyStore not initialized");
    return this.privateKey;
  }

  async importPrivateKey(key: string): Promise<void> {
    // Validate: attempt to derive public key, throws if invalid
    const pub = getPublicKey(key);
    this.privateKey = key;
    this.publicKey = pub;
    await this.saveToStorage(key);
  }

  isEphemeral(): boolean {
    return this.ephemeral;
  }

  private async loadFromStorage(): Promise<string | null> {
    if (!this.isIndexedDBAvailable()) {
      this.ephemeral = true;
      return null;
    }
    try {
      const db = await this.openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(KEY);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      this.ephemeral = true;
      return null;
    }
  }

  private async saveToStorage(value: string): Promise<void> {
    if (this.ephemeral) return;
    try {
      const db = await this.openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(value, KEY);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch {
      this.ephemeral = true;
    }
  }

  private isIndexedDBAvailable(): boolean {
    try {
      return typeof indexedDB !== "undefined";
    } catch {
      return false;
    }
  }

  private openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE_NAME);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
}
