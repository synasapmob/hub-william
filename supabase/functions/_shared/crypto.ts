import type { StoredCredential } from "./provider-types.ts";

export interface EncryptedValue {
  ciphertext: string;
  initializationVector: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(value: Uint8Array) {
  let binary = "";

  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function credentialKey() {
  const encodedKey = Deno.env.get("PROVIDER_CREDENTIAL_ENCRYPTION_KEY");

  if (!encodedKey) {
    throw new Error(
      "Provider credential encryption configuration is required.",
    );
  }

  const keyBytes = base64ToBytes(encodedKey);

  if (keyBytes.byteLength !== 32) {
    throw new Error("Provider credential encryption configuration is invalid.");
  }

  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptCredential(
  credential: StoredCredential,
): Promise<EncryptedValue> {
  const initializationVector = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: initializationVector },
    await credentialKey(),
    encoder.encode(JSON.stringify(credential)),
  );

  return {
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    initializationVector: bytesToBase64(initializationVector),
  };
}

export async function decryptCredential(
  encrypted: EncryptedValue,
): Promise<StoredCredential> {
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(encrypted.initializationVector),
    },
    await credentialKey(),
    base64ToBytes(encrypted.ciphertext),
  );

  return JSON.parse(decoder.decode(decrypted)) as StoredCredential;
}
