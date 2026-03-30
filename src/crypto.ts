// Encryption key management
// Key is derived from a random salt stored in chrome.storage.local
// This means only this extension instance can decrypt the data

const SALT_KEY = 'edukatus-analytics-encryption-salt';
const KEY_USAGE: KeyUsage[] = ['encrypt', 'decrypt'];

let cachedKey: CryptoKey | null = null;

async function getOrCreateSalt(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get(SALT_KEY, (result) => {
      if (result[SALT_KEY]) {
        resolve(result[SALT_KEY] as string);
      } else {
        const salt = crypto.getRandomValues(new Uint8Array(32));
        const saltHex = Array.from(salt).map((b) => b.toString(16).padStart(2, '0')).join('');
        chrome.storage.local.set({ [SALT_KEY]: saltHex });
        resolve(saltHex);
      }
    });
  });
}

async function getEncryptionKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;

  const salt = await getOrCreateSalt();
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(salt + chrome.runtime.id),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  cachedKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode('edukatus-analytics'), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    KEY_USAGE,
  );

  return cachedKey;
}

export async function encryptData(plaintext: string): Promise<string> {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext),
  );

  // Combine IV + ciphertext, encode as base64
  const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return btoa(String.fromCharCode(...combined));
}

export async function decryptData(encrypted: string): Promise<string> {
  const key = await getEncryptionKey();

  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext,
  );

  return new TextDecoder().decode(plaintext);
}
