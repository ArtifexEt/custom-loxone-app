import CryptoJS from 'crypto-js';
import forge from 'node-forge';

async function readConfig() {
  if (process.argv[2]) {
    const [origin, username, password, uuidAction, answersStateUuid, deviceStateUuid] = process.argv.slice(2);
    return { origin, username, password, uuidAction, answersStateUuid, deviceStateUuid };
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
const answersStateUuid = config?.answersStateUuid;
const deviceStateUuid = config?.deviceStateUuid;

if (!origin || !username || !password || !uuidAction || !answersStateUuid || !deviceStateUuid) {
  console.error('usage: node tmp-playwright/probe-intercom-state-http.mjs <origin> <username> <password> <uuidAction> <answersStateUuid> <deviceStateUuid>');
  console.error('or pipe JSON');
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
  const payload = JSON.parse(raw);
  const root = payload.LL ?? payload.ll ?? payload;
  const code = Number(root.Code ?? root.code ?? 200);
  if (code >= 400) {
    throw new Error(`${command} -> ${code} ${JSON.stringify(root.value ?? root.Value ?? null)}`);
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
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${user}:${passwordHash}`));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function getToken(baseOrigin) {
  const publicKeyResponse = await fetch(new URL('jdev/sys/getPublicKey', ensureTrailingSlash(baseOrigin)));
  const publicKeyPayload = parseCommandPayload(await publicKeyResponse.text(), 'jdev/sys/getPublicKey');
  const publicKeyPem = normalizePublicKeyPem(publicKeyPayload.value);
  const resolvedOrigin = resolveAuthResponseOrigin(baseOrigin, publicKeyResponse.url, 'jdev/sys/getPublicKey');
  const authOrigin = resolveAuthBootstrapOrigin(publicKeyResponse.url);
  const tokenSalts = await requestEncryptedValue(authOrigin, `jdev/sys/getkey2/${encodeURIComponent(username)}`, publicKeyPem);
  const key = String(tokenSalts.value.key);
  const salt = String(tokenSalts.value.salt);
  const hashAlg = String(tokenSalts.value.hashAlg ?? 'SHA1').toUpperCase();
  const passwordHash = await hashPassword(password, salt, hashAlg);
  const userHash = await hmacUserHash(username, passwordHash, key, hashAlg);
  const clientUuid = crypto.randomUUID();
  const tokenPayload = await requestEncryptedValue(
    authOrigin,
    `jdev/sys/getjwt/${userHash}/${encodeURIComponent(username)}/4/${encodeURIComponent(clientUuid)}/${encodeURIComponent('StateProbe')}`,
    publicKeyPem,
  );
  return {
    resolvedOrigin,
    token: String(tokenPayload.value.token),
  };
}

async function fetchStateValue(resolvedOrigin, token, stateUuid) {
  const url = `${ensureTrailingSlash(resolvedOrigin)}jdev/sps/io/${encodeURIComponent(stateUuid)}?autht=${encodeURIComponent(token)}`;
  const response = await fetch(url);
  const text = await response.text();
  return {
    status: response.status,
    payload: parseCommandPayload(text, stateUuid).value ?? null,
  };
}

async function runAction(resolvedOrigin, token, actionUuid, command) {
  const encodedCommand = encodeURIComponent(command).replaceAll('%2F', '/');
  const url = `${ensureTrailingSlash(resolvedOrigin)}jdev/sps/io/${encodeURIComponent(actionUuid)}/${encodedCommand}?autht=${encodeURIComponent(token)}`;
  const response = await fetch(url);
  const text = await response.text();
  return {
    status: response.status,
    payload: parseCommandPayload(text, command).value ?? null,
  };
}

const { resolvedOrigin, token } = await getToken(origin);

const samples = [];
samples.push({
  step: 'before',
  answers: await fetchStateValue(resolvedOrigin, token, answersStateUuid),
  deviceState: await fetchStateValue(resolvedOrigin, token, deviceStateUuid),
});

const action = await runAction(resolvedOrigin, token, uuidAction, 'connect');

for (const delayMs of [200, 500, 1000, 2000, 4000, 7000]) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  samples.push({
    step: `after_${delayMs}ms`,
    answers: await fetchStateValue(resolvedOrigin, token, answersStateUuid),
    deviceState: await fetchStateValue(resolvedOrigin, token, deviceStateUuid),
  });
}

console.log(JSON.stringify({ resolvedOrigin, action, samples }, null, 2));
