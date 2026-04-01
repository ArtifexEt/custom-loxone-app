import CryptoJS from 'crypto-js';
import forge from 'node-forge';

async function readConfig() {
  if (process.argv[2]) {
    const [origin, username, password, deviceUuid] = process.argv.slice(2);
    return { origin, username, password, deviceUuid };
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
const deviceUuid = config?.deviceUuid;

if (!origin || !username || !password || !deviceUuid) {
  console.error('usage: node tmp-playwright/probe-signaling.mjs <origin> <username> <password> <deviceUuid>');
  console.error('or pipe JSON: {"origin":"...","username":"...","password":"...","deviceUuid":"..."}');
  process.exit(2);
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

async function tryDecryptEncryptedResponse(value, keyHex, ivHex) {
  try {
    return await decryptEncryptedResponse(value, keyHex, ivHex);
  } catch {
    return null;
  }
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
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
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

async function getToken(baseOrigin) {
  const normalizedOrigin = new URL(baseOrigin.endsWith('/') ? baseOrigin : `${baseOrigin}/`).toString();
  const publicKeyResponse = await fetch(new URL('jdev/sys/getPublicKey', normalizedOrigin));
  const publicKeyText = await publicKeyResponse.text();
  const publicKeyJson = JSON.parse(publicKeyText);
  const publicKeyPem = normalizePublicKeyPem(publicKeyJson.LL.value);
  const authOrigin = new URL('.', publicKeyResponse.url).toString();
  const runtimeOriginUrl = new URL(publicKeyResponse.url);
  runtimeOriginUrl.pathname = '/';
  runtimeOriginUrl.search = '';
  runtimeOriginUrl.hash = '';
  const runtimeOrigin = runtimeOriginUrl.toString();

  const getkey2Request = await encryptCommand(
    authOrigin,
    `jdev/sys/getkey2/${encodeURIComponent(username)}`,
    publicKeyPem,
  );
  const getkey2Response = await fetch(getkey2Request.url);
  const getkey2Text = await getkey2Response.text();
  const getkey2Decrypted = await tryDecryptEncryptedResponse(
    getkey2Text,
    getkey2Request.aesKey,
    getkey2Request.aesIv,
  );
  if (!getkey2Decrypted) {
    throw new Error(`Unable to decrypt getkey2 response: ${getkey2Text.slice(0, 200)}`);
  }
  const tokenSalts = JSON.parse(getkey2Decrypted).LL.value;
  const hashAlg = String(tokenSalts.hashAlg ?? 'SHA1').toUpperCase();
  const passwordHash = await hashPassword(password, String(tokenSalts.salt), hashAlg);
  const userHash = await hmacUserHash(username, passwordHash, String(tokenSalts.key), hashAlg);
  const jwtPath = `jdev/sys/getjwt/${userHash}/${encodeURIComponent(username)}/4/${encodeURIComponent(
    crypto.randomUUID(),
  )}/${encodeURIComponent('CustomLoxoneApp')}`;
  const getjwtRequest = await encryptCommand(authOrigin, jwtPath, publicKeyPem);
  const getjwtResponse = await fetch(getjwtRequest.url);
  const getjwtText = await getjwtResponse.text();
  const getjwtDecrypted = await tryDecryptEncryptedResponse(
    getjwtText,
    getjwtRequest.aesKey,
    getjwtRequest.aesIv,
  );
  if (!getjwtDecrypted) {
    throw new Error(`Unable to decrypt getjwt response: ${getjwtText.slice(0, 200)}`);
  }
  const jwtPayload = JSON.parse(getjwtDecrypted).LL.value;
  return {
    runtimeOrigin,
    token: String(jwtPayload.token),
  };
}

function encryptIntercomEnvelope(value, publicKey, modulus, exponent) {
  let key = null;
  if (publicKey) {
    key = forge.pki.publicKeyFromPem(publicKey);
  } else if (modulus && exponent) {
    key = forge.pki.setRsaPublicKey(
      new forge.jsbn.BigInteger(modulus, 16),
      new forge.jsbn.BigInteger(exponent, 16),
    );
  }
  if (!key) {
    throw new Error('Missing signaling public key');
  }
  return forge.util.encode64(key.encrypt(value, 'RSAES-PKCS1-V1_5'));
}

async function buildIntercomAuthenticationPayload(token, sessionToken, modulus, exponent, publicKey) {
  const passphrase = CryptoJS.lib.WordArray.random(16).toString(CryptoJS.enc.Hex);
  const encryptedToken = CryptoJS.AES.encrypt(token, passphrase, {
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });
  const envelope = [
    encryptedToken.key.toString(CryptoJS.enc.Hex),
    encryptedToken.iv.toString(CryptoJS.enc.Hex),
    sessionToken,
  ].join(':');
  return [
    username,
    encryptIntercomEnvelope(envelope, publicKey, modulus, exponent),
    encryptedToken.ciphertext.toString(CryptoJS.enc.Base64),
  ];
}

const tokenInfo = await getToken(origin);
const wsOrigin = tokenInfo.runtimeOrigin.replace(/^http/, 'ws').replace(/\/$/, '');
const wsUrl = `${wsOrigin}/proxy/${encodeURIComponent(deviceUuid)}/`;
const socket = new WebSocket(wsUrl, 'webrtc-signaling');

const events = [];
const finish = () => {
  console.log(JSON.stringify({ wsUrl, events }, null, 2));
  process.exit(0);
};

const infoRequestId = 1;

socket.addEventListener('open', () => {
  events.push({ kind: 'open', url: wsUrl });
});

socket.addEventListener('message', async (event) => {
  const text = String(event.data);
  events.push({ kind: 'recv', text });
  const message = JSON.parse(text);

  if (message.method === 'authenticate') {
    const [sessionToken, modulus, exponent, publicKey] = message.params ?? [];
    const data = await buildIntercomAuthenticationPayload(
      tokenInfo.token,
      String(sessionToken ?? ''),
      typeof modulus === 'string' ? modulus : null,
      typeof exponent === 'string' ? exponent : null,
      typeof publicKey === 'string' ? publicKey : null,
    );
    const payload = {
      jsonrpc: '2.0',
      result: { code: 200, message: 'Ok', data },
      id: message.id,
    };
    events.push({ kind: 'send', payload });
    socket.send(JSON.stringify(payload));
    return;
  }

  if (message.method === 'ready') {
    const infoPayload = {
      jsonrpc: '2.0',
      method: 'info',
      id: infoRequestId,
    };
    events.push({ kind: 'send', payload: infoPayload });
    socket.send(JSON.stringify(infoPayload));
    return;
  }

  if (message.method === 'reachMode') {
    const ack = {
      jsonrpc: '2.0',
      result: { code: 200, message: 'Ok' },
      id: message.id,
    };
    events.push({ kind: 'send', payload: ack });
    socket.send(JSON.stringify(ack));
    return;
  }

  if (message.id === infoRequestId) {
    finish();
  }
});

socket.addEventListener('close', (event) => {
  events.push({ kind: 'close', code: event.code, reason: event.reason });
  finish();
});

socket.addEventListener('error', () => {
  events.push({ kind: 'error' });
});

setTimeout(() => {
  events.push({ kind: 'timeout' });
  try {
    socket.close();
  } catch {}
  finish();
}, 15000);
