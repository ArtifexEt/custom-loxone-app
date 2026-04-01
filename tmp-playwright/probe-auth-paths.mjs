import CryptoJS from 'crypto-js';
import forge from 'node-forge';

const origin = process.argv[2];
const username = process.argv[3];

if (!origin || !username) {
  console.error('usage: node tmp-playwright/probe-auth-paths.mjs <origin> <username>');
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
    encryptedPayload,
    encryptedSessionKey,
  };
}

const publicKeyResponse = await fetch(new URL('jdev/sys/getPublicKey', ensureTrailingSlash(origin)));
console.error(`getPublicKey -> ${publicKeyResponse.url} status=${publicKeyResponse.status}`);
const publicKeyPayload = parseCommandPayload(await publicKeyResponse.text(), 'jdev/sys/getPublicKey');
const publicKeyPem = normalizePublicKeyPem(publicKeyPayload.value);
const resolvedOrigin = resolveAuthResponseOrigin(origin, publicKeyResponse.url, 'jdev/sys/getPublicKey');
const authOrigin = resolveAuthBootstrapOrigin(publicKeyResponse.url);

const commands = [
  'jdev/sys/getkey2/' + encodeURIComponent(username),
  'getkey2/' + encodeURIComponent(username),
];
const bases = [resolvedOrigin, authOrigin];

const results = [];
for (const base of bases) {
  for (const command of commands) {
    const encrypted = await encryptCommand(command, publicKeyPem);
    const candidates = [
      `${ensureTrailingSlash(base)}jdev/sys/fenc/${encodeURIComponent(encrypted.encryptedPayload)}?sk=${encodeURIComponent(encrypted.encryptedSessionKey)}`,
      `${ensureTrailingSlash(base)}fenc/${encodeURIComponent(encrypted.encryptedPayload)}?sk=${encodeURIComponent(encrypted.encryptedSessionKey)}`,
    ];
    for (const url of candidates) {
      const response = await fetch(url);
      const text = await response.text();
      results.push({
        base,
        command,
        url,
        status: response.status,
        sample: text.slice(0, 200),
      });
    }
  }
}

console.log(JSON.stringify({ resolvedOrigin, authOrigin, results }, null, 2));
