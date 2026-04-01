import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const origin = process.argv[2];
const username = process.argv[3];
const password = process.argv[4];
const deviceUuid = process.argv[5];
const cameraUuid = process.argv[6];

if (!origin || !username || !password || !deviceUuid || !cameraUuid) {
  console.error('usage: node tmp-playwright/probe-media.mjs <origin> <username> <password> <deviceUuid> <cameraUuid>');
  process.exit(2);
}

const { stdout } = await execFileAsync(
  process.execPath,
  ['tmp-playwright/get-token.mjs', origin, username, password],
  { cwd: process.cwd(), maxBuffer: 1024 * 1024 * 4 },
);

const tokenInfo = JSON.parse(stdout);
const runtimeOrigin = tokenInfo.resolvedOrigin.replace(/\/$/, '');

const candidates = [
  [`proxy-jpg-autht`, `${runtimeOrigin}/proxy/${deviceUuid}/jpg/image.jpg?autht=${encodeURIComponent(tokenInfo.token)}`],
  [`proxy-mjpg-autht`, `${runtimeOrigin}/proxy/${deviceUuid}/mjpg/video.mjpg?autht=${encodeURIComponent(tokenInfo.token)}`],
  [`camimage-auth`, `${runtimeOrigin}/camimage/${cameraUuid}?auth=${encodeURIComponent(tokenInfo.token)}`],
  [`camimage-autht`, `${runtimeOrigin}/camimage/${cameraUuid}?autht=${encodeURIComponent(tokenInfo.token)}`],
];

for (const [label, url] of candidates) {
  const response = await fetch(url, { method: 'GET', redirect: 'manual' });
  console.log(`${label} ${response.status} ${response.headers.get('content-type') ?? ''}`);
}
