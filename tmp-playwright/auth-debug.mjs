import CryptoJS from 'crypto-js';
import forge from 'node-forge';

const origin = process.env.LOXONE_ORIGIN;
const username = process.env.LOXONE_USERNAME;
const password = process.env.LOXONE_PASSWORD;

if (!origin || !username || !password) {
  console.error('Missing env');
  process.exit(2);
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function sanitizeJsonLikeText(value) {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/g, '');
}

function parseCommandPayload(raw, command) {
  const trimmed = sanitizeJsonLikeText(raw).trim();
  const parsed = JSON.parse(trimmed);
  if (parsed && typeof parsed === 'object' && 'LL' in parsed) {
    const root = parsed.LL;
    const code = Number(root.Code ?? root.code ?? 0);
    return {
      code,
      control: String(root.control ?? command),
      value: typeof root.value === 'string' && (root.value.trim().startsWith('{') || root.value.trim().startsWith('['))
        ? JSON.parse(root.value)
        : root.value,
    };
  }
  return { code: 200, control: command, value: parsed };
}

function normalizePublicKeyPem(value) {
  const trimmed = value.trim();
  if (trimmed.includes('\n')) {
    return trimmed
      .replace('BEGIN CERTIFICATE', 'BEGIN PUBLIC KEY')
      .replace('END CERTIFICATE', 'END PUBLIC KEY');
  }
  const begin = '-----BEGIN CERTIFICATE-----';
  const end = '-----END CERTIFICATE-----';
  if (!trimmed.startsWith(begin) || !trimmed.endsWith(end)) {
    return trimmed;
  }
  const body = trimmed.slice(begin.length, trimmed.length - end.length);
  return `-----BEGIN PUBLIC KEY-----\n${body.match(/.{1,64}/g)?.join('\n') ?? body}\n-----END PUBLIC KEY-----`;
}

function resolveAuthResponseOrigin(originValue, responseUrl, commandPath) {
  const fallback = new URL(originValue);
  const response = new URL(responseUrl, fallback);
  const commandUrl = new URL(commandPath, ensureTrailingSlash(fallback.toString()));
  const commandPathname = commandUrl.pathname;
  const commandSuffix = `/${commandPath.replace(/^\/+/, '')}`;
  const matchedSuffix = response.pathname.endsWith(commandPathname)
    ? commandPathname
    : response.pathname.endsWith(commandSuffix)
      ? commandSuffix
      : null;
  if (matchedSuffix) {
    const trimmedPath = response.pathname.slice(0, response.pathname.length - matchedSuffix.length);
    response.pathname = trimmedPath || '/';
  }
  response.search = '';
  response.hash = '';
  return response.toString().replace(/\/$/, '');
}

async function aesEncryptBase64(value, keyHex, ivHex) {
  return CryptoJS.AES.encrypt(value, CryptoJS.enc.Hex.parse(keyHex), {
    iv: CryptoJS.enc.Hex.parse(ivHex),
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.ZeroPadding,
  }).ciphertext.toString(CryptoJS.enc.Base64);
}

async function decryptEncryptedResponse(value, keyHex, ivHex) {
  const base64 = value.replace(/\n/g, '');
  const hex = CryptoJS.enc.Base64.parse(base64).toString(CryptoJS.enc.Hex);
  const paddedHex = hex.length % 16 > 0 ? `${hex}${'0'.repeat(16 - (hex.length % 16))}` : hex;
  const cipherParams = CryptoJS.lib.CipherParams.create({
    ciphertext: CryptoJS.enc.Hex.parse(paddedHex),
  });
  return CryptoJS.AES.decrypt(cipherParams, CryptoJS.enc.Hex.parse(keyHex), {
    iv: CryptoJS.enc.Hex.parse(ivHex),
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.ZeroPadding,
  }).toString(CryptoJS.enc.Utf8).replace(/[\0-\x1f]+$/g, '');
}

async function encryptCommand(command, publicKeyPem) {
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
    encryptedCommand: `jdev/sys/fenc/${encodeURIComponent(encryptedPayload)}`,
    encryptedSessionKey,
  };
}

async function requestEncryptedValue(originValue, command, publicKeyPem) {
  const encrypted = await encryptCommand(command, publicKeyPem);
  const url = `${ensureTrailingSlash(originValue)}${encrypted.encryptedCommand}?sk=${encodeURIComponent(encrypted.encryptedSessionKey)}`;
  const response = await fetch(url);
  const rawResponse = await response.text();
  const decrypted = await decryptEncryptedResponse(rawResponse, encrypted.aesKey, encrypted.aesIv).catch(() => null);
  const payload = parseCommandPayload(decrypted ?? rawResponse, command);
  return { url, rawResponse, decrypted, payload };
}

const publicKeyResponse = await fetch(new URL('jdev/sys/getPublicKey', ensureTrailingSlash(origin)));
const publicKeyRaw = await publicKeyResponse.text();
const publicKeyPayload = parseCommandPayload(publicKeyRaw, 'jdev/sys/getPublicKey');
const publicKeyPem = normalizePublicKeyPem(String(publicKeyPayload.value ?? ''));
const resolvedOrigin = resolveAuthResponseOrigin(origin, publicKeyResponse.url, 'jdev/sys/getPublicKey');

console.log(JSON.stringify({
  step: 'getPublicKey',
  requestedOrigin: origin,
  responseUrl: publicKeyResponse.url,
  resolvedOrigin,
  payload: publicKeyPayload,
}, null, 2));

const getKey2 = await requestEncryptedValue(
  resolvedOrigin,
  `jdev/sys/getkey2/${encodeURIComponent(username)}`,
  publicKeyPem,
);

console.log(JSON.stringify({
  step: 'getkey2',
  url: getKey2.url,
  payload: getKey2.payload,
  decrypted: getKey2.decrypted,
}, null, 2));
