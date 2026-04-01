import forge from 'node-forge';
import CryptoJS from 'crypto-js';

const origin = process.env.LOXONE_ORIGIN;
const username = process.env.LOXONE_USERNAME;
const password = process.env.LOXONE_PASSWORD;

if (!origin || !username || !password) {
  throw new Error('LOXONE_ORIGIN, LOXONE_USERNAME and LOXONE_PASSWORD are required');
}

function normalizePublicKeyPem(value) {
  const trimmed = String(value).trim();
  if (trimmed.includes('\n')) {
    return trimmed
      .replace('BEGIN CERTIFICATE', 'BEGIN PUBLIC KEY')
      .replace('END CERTIFICATE', 'END PUBLIC KEY');
  }
  const begin = '-----BEGIN CERTIFICATE-----';
  const end = '-----END CERTIFICATE-----';
  const body = trimmed.slice(begin.length, trimmed.length - end.length);
  return `-----BEGIN PUBLIC KEY-----\n${body.match(/.{1,64}/g)?.join('\n') ?? body}\n-----END PUBLIC KEY-----`;
}

async function aesEncryptBase64(value, keyHex, ivHex) {
  return CryptoJS.AES.encrypt(value, CryptoJS.enc.Hex.parse(keyHex), {
    iv: CryptoJS.enc.Hex.parse(ivHex),
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.ZeroPadding,
  }).ciphertext.toString(CryptoJS.enc.Base64);
}

async function decryptEncryptedResponse(value, keyHex, ivHex) {
  const base64 = String(value).replace(/\n/g, '');
  const hex = CryptoJS.enc.Base64.parse(base64).toString(CryptoJS.enc.Hex);
  const paddedHex = hex.length % 16 > 0 ? `${hex}${'0'.repeat(16 - (hex.length % 16))}` : hex;
  const cipherParams = CryptoJS.lib.CipherParams.create({
    ciphertext: CryptoJS.enc.Hex.parse(paddedHex),
  });
  return CryptoJS.AES.decrypt(cipherParams, CryptoJS.enc.Hex.parse(keyHex), {
    iv: CryptoJS.enc.Hex.parse(ivHex),
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.ZeroPadding,
  })
    .toString(CryptoJS.enc.Utf8)
    .replace(/[\0-\x1f]+$/g, '');
}

async function encryptCommand(originUrl, command, publicKeyPem) {
  const salt = forge.util.bytesToHex(forge.random.getBytesSync(2));
  const plainCommand = `salt/${salt}/${command}`;
  const aesKey = forge.pkcs5.pbkdf2(
    forge.util.bytesToHex(forge.random.getBytesSync(36)),
    forge.random.getBytesSync(16),
    50,
    32,
  );
  const aesIv = forge.util.bytesToHex(forge.random.getBytesSync(16));
  const encryptedPayload = await aesEncryptBase64(plainCommand, aesKey, aesIv);
  const rsaPublicKey = forge.pki.publicKeyFromPem(publicKeyPem);
  const encryptedSessionKey = forge.util.encode64(
    rsaPublicKey.encrypt(`${aesKey}:${aesIv}`, 'RSAES-PKCS1-V1_5'),
  );
  return {
    aesKey,
    aesIv,
    url: new URL(
      `jdev/sys/fenc/${encodeURIComponent(encryptedPayload)}?sk=${encodeURIComponent(encryptedSessionKey)}`,
      originUrl,
    ).toString(),
  };
}

function arrayBufferToHex(value) {
  return Array.from(new Uint8Array(value))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function hashPassword(passwordValue, salt, hashAlgorithm) {
  const payload = new TextEncoder().encode(`${passwordValue}:${salt}`);
  const hash = await crypto.subtle.digest(hashAlgorithm.includes('256') ? 'SHA-256' : 'SHA-1', payload);
  return arrayBufferToHex(hash).toUpperCase();
}

function hexToBytes(value) {
  const normalized = value.trim();
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return bytes;
}

function bytesToArrayBuffer(value) {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}

async function hmacUserHash(user, passwordHash, keyHex, hashAlgorithm) {
  const key = await crypto.subtle.importKey(
    'raw',
    bytesToArrayBuffer(hexToBytes(keyHex)),
    {
      name: 'HMAC',
      hash: hashAlgorithm.includes('256') ? 'SHA-256' : 'SHA-1',
    },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${user}:${passwordHash}`),
  );
  return arrayBufferToHex(signature);
}

async function fetchText(url) {
  const response = await fetch(url);
  const text = await response.text();
  return { response, text };
}

const normalizedOrigin = new URL(origin.endsWith('/') ? origin : `${origin}/`).toString();
const publicKeyResult = await fetchText(new URL('jdev/sys/getPublicKey', normalizedOrigin));
console.log('publicKey final URL', publicKeyResult.response.url);
const publicKeyJson = JSON.parse(publicKeyResult.text);
const publicKeyPem = normalizePublicKeyPem(publicKeyJson.LL.value);
const authOrigin = new URL('.', publicKeyResult.response.url).toString();
const runtimeOriginUrl = new URL(publicKeyResult.response.url);
runtimeOriginUrl.pathname = '/';
runtimeOriginUrl.search = '';
runtimeOriginUrl.hash = '';
const runtimeOrigin = runtimeOriginUrl.toString();
console.log('auth bootstrap origin', authOrigin);
console.log('runtime origin', runtimeOrigin);

const getkey2Request = await encryptCommand(
  authOrigin,
  `jdev/sys/getkey2/${encodeURIComponent(username)}`,
  publicKeyPem,
);
const getkey2Result = await fetchText(getkey2Request.url);
console.log('getkey2 final URL', getkey2Result.response.url);
console.log('getkey2 status', getkey2Result.response.status);
console.log('getkey2 raw', getkey2Result.text.slice(0, 300));
const getkey2Decrypted = await decryptEncryptedResponse(
  getkey2Result.text,
  getkey2Request.aesKey,
  getkey2Request.aesIv,
);
console.log('getkey2 decrypted', getkey2Decrypted);

const tokenSalts = JSON.parse(getkey2Decrypted).LL.value;
const key = String(tokenSalts.key).trim();
const salt = String(tokenSalts.salt).trim();
const hashAlg = String(tokenSalts.hashAlg ?? 'SHA1').toUpperCase();
const passwordHash = await hashPassword(password, salt, hashAlg);
const userHash = await hmacUserHash(username, passwordHash, key, hashAlg);
const jwtPath = `jdev/sys/getjwt/${userHash}/${encodeURIComponent(username)}/4/${encodeURIComponent(
  crypto.randomUUID(),
)}/${encodeURIComponent('CustomLoxoneApp')}`;
const getjwtRequest = await encryptCommand(authOrigin, jwtPath, publicKeyPem);
const getjwtResult = await fetchText(getjwtRequest.url);
console.log('getjwt final URL', getjwtResult.response.url);
console.log('getjwt raw', getjwtResult.text.slice(0, 500));
try {
  console.log(
    'getjwt decrypted',
    await decryptEncryptedResponse(getjwtResult.text, getjwtRequest.aesKey, getjwtRequest.aesIv),
  );
} catch (error) {
  console.log('getjwt decrypt error', String(error));
}
