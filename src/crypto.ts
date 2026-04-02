// Encryption with graceful fallback
// If crypto APIs aren't available or fail, falls back to base64 obfuscation
// This ensures the extension works in all browser contexts

const SALT_KEY = 'edukatus-analytics-encryption-salt';
const KEY_USAGE: KeyUsage[] = ['encrypt', 'decrypt'];

let cachedKey: CryptoKey | null = null;
let cryptoAvailable: boolean | null = null;

async function isCryptoAvailable(): Promise<boolean> {
  if (cryptoAvailable !== null) return cryptoAvailable;
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      cryptoAvailable = false;
      return false;
    }
    // Test that chrome.storage.local works
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout')), 2000);
      chrome.storage.local.get('__test__', () => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
    cryptoAvailable = true;
  } catch (e) {
    console.warn('[crypto] Crypto or storage not available, using fallback:', e);
    cryptoAvailable = false;
  }
  return cryptoAvailable;
}

async function getOrCreateSalt(): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('storage timeout')), 3000);
    chrome.storage.local.get(SALT_KEY, (result) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (result[SALT_KEY]) {
        resolve(result[SALT_KEY] as string);
      } else {
        const salt = crypto.getRandomValues(new Uint8Array(32));
        const saltHex = Array.from(salt).map((b) => b.toString(16).padStart(2, '0')).join('');
        chrome.storage.local.set({ [SALT_KEY]: saltHex }, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(saltHex);
          }
        });
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
    encoder.encode(salt + (chrome.runtime?.id ?? 'edukatus')),
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

// Fallback: simple base64 encoding (not encryption, but prevents casual reading)
function fallbackEncode(plaintext: string): string {
  try {
    // Use TextEncoder for proper UTF-8 handling, then base64
    const bytes = new TextEncoder().encode(plaintext);
    const binStr = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    return 'b64:' + btoa(binStr);
  } catch {
    return 'raw:' + plaintext;
  }
}

function fallbackDecode(encoded: string): string {
  try {
    if (encoded.startsWith('b64:')) {
      const binStr = atob(encoded.slice(4));
      const bytes = Uint8Array.from(binStr, (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }
    if (encoded.startsWith('raw:')) {
      return encoded.slice(4);
    }
    // Try as encrypted data (legacy)
    return encoded;
  } catch {
    return encoded;
  }
}

export async function encryptData(plaintext: string): Promise<string> {
  try {
    if (!(await isCryptoAvailable())) {
      return fallbackEncode(plaintext);
    }

    const key = await getEncryptionKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const data = encoder.encode(plaintext);

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      data,
    );

    // Combine IV + ciphertext, encode as base64
    const ctArray = new Uint8Array(ciphertext);
    const combined = new Uint8Array(iv.length + ctArray.length);
    combined.set(iv);
    combined.set(ctArray, iv.length);

    // Use chunked btoa to avoid call stack limits on large data
    const binStr = Array.from(combined, (b) => String.fromCharCode(b)).join('');
    return 'enc:' + btoa(binStr);
  } catch (e) {
    console.warn('[crypto] Encryption failed, using fallback:', e);
    return fallbackEncode(plaintext);
  }
}

export async function decryptData(encrypted: string): Promise<string> {
  try {
    // Handle fallback-encoded data
    if (encrypted.startsWith('b64:') || encrypted.startsWith('raw:')) {
      return fallbackDecode(encrypted);
    }

    // Handle encrypted data
    const data = encrypted.startsWith('enc:') ? encrypted.slice(4) : encrypted;

    if (!(await isCryptoAvailable())) {
      // Can't decrypt without crypto — return empty
      console.warn('[crypto] Cannot decrypt: crypto not available');
      return '[]';
    }

    const key = await getEncryptionKey();
    const binStr = atob(data);
    const combined = Uint8Array.from(binStr, (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext,
    );

    return new TextDecoder().decode(plaintext);
  } catch (e) {
    console.warn('[crypto] Decryption failed:', e);
    // Try fallback decode
    return fallbackDecode(encrypted);
  }
}
