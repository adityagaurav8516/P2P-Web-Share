/**
 * Zero-Knowledge Cryptographic Utilities using the Web Crypto API
 */

// Convert a byte array to a hex string
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Convert a hex string to a byte array
export function hexToBytes(hex: string): Uint8Array {
  // Remove any non-hex characters just in case
  const cleanHex = hex.replace(/[^0-9a-fA-F]/g, "");
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.substring(i, i + 2), 16);
  }
  return bytes;
}

// Generate a random 256-bit AES-GCM key represented as a 64-char hex string
export function generateKeyHex(): string {
  const bytes = new Uint8Array(32); // 256 bits
  window.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

// Import a CryptoKey from a hex string
export async function importKeyFromHex(hexKey: string): Promise<CryptoKey> {
  const keyBytes = hexToBytes(hexKey);
  return await window.crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false, // not extractable
    ["encrypt", "decrypt"]
  );
}

// Encrypt an ArrayBuffer with AES-GCM
export async function encryptBuffer(
  buffer: ArrayBuffer,
  cryptoKey: CryptoKey
): Promise<{ encryptedBuffer: ArrayBuffer; ivHex: string }> {
  // Generate random 12-byte initialization vector (recommended for GCM)
  const iv = new Uint8Array(12);
  window.crypto.getRandomValues(iv);

  const encryptedBuffer = await window.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv,
    },
    cryptoKey,
    buffer
  );

  return {
    encryptedBuffer,
    ivHex: bytesToHex(iv),
  };
}

// Decrypt an ArrayBuffer with AES-GCM
export async function decryptBuffer(
  encryptedBuffer: ArrayBuffer,
  ivHex: string,
  cryptoKey: CryptoKey
): Promise<ArrayBuffer> {
  const iv = hexToBytes(ivHex);
  return await window.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv,
    },
    cryptoKey,
    encryptedBuffer
  );
}

// Compute SHA-256 hash of an ArrayBuffer
export async function computeSHA256(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await window.crypto.subtle.digest("SHA-256", buffer);
  return bytesToHex(new Uint8Array(hashBuffer));
}
