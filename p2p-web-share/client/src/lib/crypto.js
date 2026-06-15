const textEncoder = new TextEncoder();

export function supportsRequiredCrypto() {
  return Boolean(globalThis.crypto?.subtle && globalThis.crypto?.getRandomValues);
}

export function base64UrlEncode(bytes) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlDecode(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(data) {
  const buffer = data instanceof ArrayBuffer ? data : textEncoder.encode(String(data)).buffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return bufferToHex(digest);
}

export function generateKeyString() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function importAesKey(keyString) {
  const raw = base64UrlDecode(keyString);
  if (raw.byteLength !== 32) {
    throw new Error("Invalid transfer key. Expected a 256-bit key in the URL hash.");
  }

  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

export function generateIv() {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  return iv;
}

export async function encryptChunk(aesKey, plainBuffer, iv) {
  return crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plainBuffer);
}

export async function decryptChunk(aesKey, cipherBuffer, ivString) {
  const iv = base64UrlDecode(ivString);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, cipherBuffer);
}
