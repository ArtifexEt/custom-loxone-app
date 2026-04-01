import CryptoJS from 'crypto-js';
import forge from 'node-forge';

async function readConfig() {
  if (process.argv[2]) {
    const [origin, username, password, uuidAction] = process.argv.slice(2);
    return { origin, username, password, uuidAction };
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return null;
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const config = await readConfig();
const origin = config?.origin;
const username = config?.username;
const password = config?.password;
const uuidAction = config?.uuidAction;

if (!origin || !username || !password || !uuidAction) {
  console.error('usage: node tmp-playwright/probe-intercom-actions.mjs <origin> <username> <password> <uuidAction>');
  console.error('or pipe JSON: {"origin":"...","username":"...","password":"...","uuidAction":"..."}');
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
  const control = String(root.control ?? root.Control ?? '');
  const value = root.value ?? root.Value ?? null;
  if (code >= 400) {
    throw new Error(`${command} -> ${code} ${control} ${JSON.stringify(value)}`);
  }
  return { code, control, value };
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
  let parsed = rawResponse;
  try {
    parsed = await decryptEncryptedResponse(rawResponse, encrypted.aesKey, encrypted.aesIv);
  } catch {
    parsed = rawResponse;
  }
  return parseCommandPayload(parsed, command);
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

const publicKeyResponse = await fetch(new URL('jdev/sys/getPublicKey', ensureTrailingSlash(origin)));
const publicKeyPayload = parseCommandPayload(await publicKeyResponse.text(), 'jdev/sys/getPublicKey');
const publicKeyPem = normalizePublicKeyPem(publicKeyPayload.value);
const resolvedOrigin = resolveAuthResponseOrigin(origin, publicKeyResponse.url, 'jdev/sys/getPublicKey');
const authOrigin = resolveAuthBootstrapOrigin(publicKeyResponse.url);
const tokenSaltsPayload = await requestEncryptedValue(
  authOrigin,
  `jdev/sys/getkey2/${encodeURIComponent(username)}`,
  publicKeyPem,
);
const tokenSalts = tokenSaltsPayload.value;
const key = String(tokenSalts.key);
const salt = String(tokenSalts.salt);
const hashAlg = String(tokenSalts.hashAlg ?? 'SHA1').toUpperCase();
const passwordHash = await hashPassword(password, salt, hashAlg);
const userHash = await hmacUserHash(username, passwordHash, key, hashAlg);
const clientUuid = crypto.randomUUID();
const clientInfo = 'IntercomActionProbe';
const tokenPayloadRoot = await requestEncryptedValue(
  authOrigin,
  `jdev/sys/getjwt/${userHash}/${encodeURIComponent(username)}/4/${encodeURIComponent(clientUuid)}/${encodeURIComponent(clientInfo)}`,
  publicKeyPem,
);
const tokenPayload = tokenPayloadRoot.value;
const token = String(tokenPayload.token);

const commands = [
  'answer',
  'connect',
  'call',
  'start',
  'mute/1',
  'mute/0',
];

const results = [];
for (const command of commands) {
  const url = `${ensureTrailingSlash(resolvedOrigin)}jdev/sps/io/${encodeURIComponent(uuidAction)}/${encodeURIComponent(command).replaceAll('%2F', '/')}?autht=${encodeURIComponent(token)}`;
  try {
    const response = await fetch(url);
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    results.push({
      command,
      status: response.status,
      url,
      parsed,
    });
  } catch (error) {
    results.push({
      command,
      status: 'fetch-error',
      url,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

console.log(JSON.stringify({ resolvedOrigin, results }, null, 2));
