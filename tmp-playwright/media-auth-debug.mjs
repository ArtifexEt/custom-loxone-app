import { execFileSync } from 'node:child_process';
import forge from 'node-forge';
import CryptoJS from 'crypto-js';

const origin = process.env.LOXONE_ORIGIN;
const username = process.env.LOXONE_USERNAME;
const password = process.env.LOXONE_PASSWORD;
const deviceUuid = process.env.LOXONE_DEVICE_UUID;
const uuidAction = process.env.LOXONE_UUID_ACTION;

if (!origin || !username || !password || !deviceUuid || !uuidAction) {
  throw new Error('Missing env');
}

function curlGet(url) {
  return execFileSync('curl', ['-fsSL', url], { encoding: 'utf8' });
}

function curlHead(url) {
  try {
    return execFileSync('curl', ['-I', '-sS', url], { encoding: 'utf8' });
  } catch (error) {
    return String(error.stdout || error.stderr || error.message);
  }
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

function parseCommandPayload(raw, command) {
  const trimmed = String(raw)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/g, '')
    .trim();
  const parsed = JSON.parse(trimmed);
  if (parsed && typeof parsed === 'object' && 'LL' in parsed) {
    const root = parsed.LL;
    return {
      code: Number(root.Code ?? root.code ?? 0),
      control: String(root.control ?? command),
      value: root.value,
    };
  }
  return { code: 200, control: command, value: parsed };
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

function hexToBytes(value) {
  const normalized = value.trim();
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    bytes[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToArrayBuffer(value) {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}

async function hashPassword(passwordValue, salt, hashAlgorithm) {
  const payload = new TextEncoder().encode(`${passwordValue}:${salt}`);
  const hash = await crypto.subtle.digest(hashAlgorithm.includes('256') ? 'SHA-256' : 'SHA-1', payload);
  return arrayBufferToHex(hash).toUpperCase();
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

const normalizedOrigin = origin.endsWith('/') ? origin : `${origin}/`;
const publicKeyUrl = new URL('jdev/sys/getPublicKey', normalizedOrigin).toString();
const publicKeyRaw = curlGet(publicKeyUrl);
const publicKeyPayload = parseCommandPayload(publicKeyRaw, 'jdev/sys/getPublicKey');
const publicKeyPem = normalizePublicKeyPem(publicKeyPayload.value);
const authOrigin = new URL('.', publicKeyUrl).toString();

const getkey2Req = await encryptCommand(authOrigin, `jdev/sys/getkey2/${encodeURIComponent(username)}`, publicKeyPem);
const getkey2Raw = curlGet(getkey2Req.url);
const getkey2Decrypted = await decryptEncryptedResponse(getkey2Raw, getkey2Req.aesKey, getkey2Req.aesIv);
const tokenSalts = JSON.parse(getkey2Decrypted).LL.value;
const hashAlg = String(tokenSalts.hashAlg ?? 'SHA1').toUpperCase();
const passwordHash = await hashPassword(password, String(tokenSalts.salt), hashAlg);
const userHash = await hmacUserHash(username, passwordHash, String(tokenSalts.key), hashAlg);

const jwtPath = `jdev/sys/getjwt/${userHash}/${encodeURIComponent(username)}/4/${encodeURIComponent(
  crypto.randomUUID(),
)}/${encodeURIComponent('CustomLoxoneApp')}`;
const jwtReq = await encryptCommand(authOrigin, jwtPath, publicKeyPem);
const jwtRaw = curlGet(jwtReq.url);
const jwtDecrypted = await decryptEncryptedResponse(jwtRaw, jwtReq.aesKey, jwtReq.aesIv);
const jwtPayload = JSON.parse(jwtDecrypted).LL.value;
const token = String(jwtPayload.token);

const base = normalizedOrigin;
const snapshot = `${base}proxy/${deviceUuid}/jpg/image.jpg?autht=${encodeURIComponent(token)}`;
const stream = `${base}proxy/${deviceUuid}/mjpg/video.mjpg?autht=${encodeURIComponent(token)}`;
const camimage = `${base}camimage/${uuidAction}?autht=${encodeURIComponent(token)}`;

console.log(
  JSON.stringify(
    {
      tokenPrefix: token.slice(0, 24),
      snapshot,
      stream,
      camimage,
      snapshotHead: curlHead(snapshot),
      streamHead: curlHead(stream),
      camimageHead: curlHead(camimage),
    },
    null,
    2,
  ),
);
