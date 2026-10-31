const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export interface EncryptedSecret {
  ct: string;
  iv: string;
  kid: string;
}

export async function encryptSecret(plain: string, masterKey: string): Promise<EncryptedSecret> {
  if (!masterKey) throw new Error("CREDENTIAL_KEY is not configured");
  const key = await deriveKey(masterKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plain),
  );
  return {
    ct: bytesToBase64(new Uint8Array(cipher)),
    iv: bytesToBase64(iv),
    kid: "v1",
  };
}

export async function decryptSecret(
  encrypted: EncryptedSecret | null | undefined,
  masterKey: string,
): Promise<string> {
  if (!encrypted?.ct || !encrypted.iv) return "";
  if (!masterKey) throw new Error("CREDENTIAL_KEY is not configured");
  const key = await deriveKey(masterKey);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(encrypted.iv) },
    key,
    base64ToBytes(encrypted.ct),
  );
  return decoder.decode(plain);
}
