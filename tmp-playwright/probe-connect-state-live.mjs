import { readFile } from 'node:fs/promises';

const live = JSON.parse(await readFile('tmp-playwright/live-current.json', 'utf8'));
const intercom = live?.debug?.workerState?.currentView?.intercom;

if (!intercom?.origin || !intercom?.authToken) {
  console.error('missing intercom origin/auth token in tmp-playwright/live-current.json');
  process.exit(2);
}

const origin = intercom.origin.replace(/\/$/, '');
const token = intercom.authToken;
const actionUuid = '1b9cd04a-0366-c7c8-ffff326fbbc40f6b';
const answersStateUuid = '1b9cd04a-0366-c7b6-ffff-95faa0999fad';
const deviceStateUuid = '1b9cd04a-0366-c7b7-ffff-95faa0999fad';
const bellStateUuid = '1b9cd04a-0366-c7b4-ffff-95faa0999fad';

async function getText(path) {
  const response = await fetch(path);
  return {
    status: response.status,
    text: await response.text(),
  };
}

async function getWithToken(pathWithoutQuery) {
  const attempts = [];
  for (const param of ['autht', 'auth']) {
    const result = await getText(`${pathWithoutQuery}?${param}=${encodeURIComponent(token)}`);
    attempts.push({ param, ...result });
    if (result.status < 400) {
      return { accepted: param, attempts };
    }
  }
  return { accepted: null, attempts };
}

async function getState(uuid) {
  return getWithToken(`${origin}/jdev/sps/io/${uuid}`);
}

async function runAction(command) {
  return getWithToken(`${origin}/jdev/sps/io/${actionUuid}/${command}`);
}

const result = {
  before: {
    answers: await getState(answersStateUuid),
    deviceState: await getState(deviceStateUuid),
    bell: await getState(bellStateUuid),
  },
  connect: await runAction('connect'),
};

for (const delayMs of [250, 1000, 3000, 7000]) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  result[`after_${delayMs}`] = {
    answers: await getState(answersStateUuid),
    deviceState: await getState(deviceStateUuid),
    bell: await getState(bellStateUuid),
  };
}

console.log(JSON.stringify(result, null, 2));
process.exit(0);
