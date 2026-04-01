import CryptoJS from 'crypto-js';
import forge from 'node-forge';

const origin = process.argv[2];
const username = process.argv[3];
const password = process.argv[4];

if (!origin || !username || !password) {
  console.error('usage: node tmp-playwright/probe-token-paths.mjs <origin> <username> <password>');
  process.exit(2);
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
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

function resolveAuthBootstrapOrigin(responseUrl) {
  const url = new URL('.', responseUrl);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function parseCommandPayload(raw, command) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    console.error(`parseCommandPayload failed for ${command}`);
    console.error(String(raw).slice(0, 400));
    throw error;
  }
  const root = payload.LL ?? payload.ll ?? payload;
  const code = Number(root.Code ?? root.code ?? 200);
  if (code >= 400) {
    throw new Error(`${command} -> ${code}`);
  }
  return root;
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
  if (!trimmed.startsWith(begin) || !trimmed.endsWith(end)) {
    return trimmed;
  }
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
    encryptedPayload,
    encryptedSessionKey,
  };
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
  })
    .toString(CryptoJS.enc.Utf8)
    .replace(/[\0-\x1f]+$/g, '');
}

async function hashPassword(passwordValue, salt, hashAlgorithm) {
  const payload = new TextEncoder().encode(`${passwordValue}:${salt}`);
  const hash = await crypto.subtle.digest(hashAlgorithm.includes('256') ? 'SHA-256' : 'SHA-1', payload);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function hexToBytes(value) {
  const normalized = value.trim();
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return bytes;
}

async function hmacUserHash(user, passwordHash, keyHex, hashAlgorithm) {
  const key = await crypto.subtle.importKey(
    'raw',
    hexToBytes(keyHex),
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
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sendEncrypted(base, command, publicKeyPem) {
  const encrypted = await encryptCommand(command, publicKeyPem);
  const urls = [
    `${ensureTrailingSlash(base)}jdev/sys/fenc/${encodeURIComponent(encrypted.encryptedPayload)}?sk=${encodeURIComponent(encrypted.encryptedSessionKey)}`,
    `${ensureTrailingSlash(base)}fenc/${encodeURIComponent(encrypted.encryptedPayload)}?sk=${encodeURIComponent(encrypted.encryptedSessionKey)}`,
  ];
  const results = [];
  for (const url of urls) {
    const response = await fetch(url);
    const raw = await response.text();
    let decrypted = raw;
    try {
      decrypted = await decryptEncryptedResponse(raw, encrypted.aesKey, encrypted.aesIv);
    } catch {
      // keep raw
    }
    results.push({
      url,
      status: response.status,
      sample: decrypted.slice(0, 300),
    });
  }
  return results;
}

const publicKeyResponse = await fetch(new URL('jdev/sys/getPublicKey', ensureTrailingSlash(origin)));
console.error(`getPublicKey -> ${publicKeyResponse.url} status=${publicKeyResponse.status}`);
const publicKeyPayload = parseCommandPayload(await publicKeyResponse.text(), 'jdev/sys/getPublicKey');
const publicKeyPem = normalizePublicKeyPem(publicKeyPayload.value);
const resolvedOrigin = resolveAuthResponseOrigin(origin, publicKeyResponse.url, 'jdev/sys/getPublicKey');
const authOrigin = resolveAuthBootstrapOrigin(publicKeyResponse.url);

const keyResults = await sendEncrypted(authOrigin, `jdev/sys/getkey2/${encodeURIComponent(username)}`, publicKeyPem);
const successfulKey = keyResults.find((item) => item.status === 200);
if (!successfulKey) {
  console.log(JSON.stringify({ resolvedOrigin, authOrigin, keyResults, tokenResults: [] }, null, 2));
  process.exit(0);
}

const tokenSalts = parseCommandPayload(successfulKey.sample, `jdev/sys/getkey2/${encodeURIComponent(username)}`);
const key = String(tokenSalts.value?.key ?? tokenSalts.key);
const salt = String(tokenSalts.value?.salt ?? tokenSalts.salt);
const hashAlg = String(tokenSalts.value?.hashAlg ?? tokenSalts.hashAlg ?? 'SHA1').toUpperCase();
const passwordHash = await hashPassword(password, salt, hashAlg);
const userHash = await hmacUserHash(username, passwordHash, key, hashAlg);

const clientUuid = crypto.randomUUID();
const clientInfo = 'Probe';
const tokenCommands = [
  `jdev/sys/getjwt/${userHash}/${encodeURIComponent(username)}/4/${encodeURIComponent(clientUuid)}/${encodeURIComponent(clientInfo)}`,
  `getjwt/${userHash}/${encodeURIComponent(username)}/4/${encodeURIComponent(clientUuid)}/${encodeURIComponent(clientInfo)}`,
  `jdev/sys/gettoken/${userHash}/${encodeURIComponent(username)}/4/${encodeURIComponent(clientUuid)}/${encodeURIComponent(clientInfo)}`,
  `gettoken/${userHash}/${encodeURIComponent(username)}/4/${encodeURIComponent(clientUuid)}/${encodeURIComponent(clientInfo)}`,
];

const tokenResults = [];
for (const command of tokenCommands) {
  const results = await sendEncrypted(authOrigin, command, publicKeyPem);
  tokenResults.push({ command, results });
}

console.log(JSON.stringify({ resolvedOrigin, authOrigin, keyResults, tokenResults }, null, 2));
