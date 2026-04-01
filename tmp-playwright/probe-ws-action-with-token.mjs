const [resolvedOrigin, token, username, uuidAction] = process.argv.slice(2);

if (!resolvedOrigin || !token || !username || !uuidAction) {
  console.error('usage: node tmp-playwright/probe-ws-action-with-token.mjs <resolvedOrigin> <token> <username> <uuidAction>');
  process.exit(2);
}

function waitForSocketOpen(socket) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (event) => {
      cleanup();
      reject(event?.error ?? new Error('socket error'));
    };
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
  });
}

function waitForTextResponse(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout'));
    }, 10000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
    };
    const onMessage = (event) => {
      const payload = event?.data;
      if (typeof payload === 'string') {
        cleanup();
        resolve(payload);
        return;
      }
      if (payload instanceof ArrayBuffer) {
        cleanup();
        resolve(new TextDecoder().decode(payload));
        return;
      }
      if (ArrayBuffer.isView(payload)) {
        cleanup();
        resolve(new TextDecoder().decode(payload));
      }
    };
    const onError = (event) => {
      cleanup();
      reject(event?.error ?? new Error('socket error'));
    };
    const onClose = () => {
      cleanup();
      reject(new Error('socket closed'));
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
  });
}

const wsUrl = resolvedOrigin.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws/rfc6455';
const socket = new WebSocket(wsUrl, 'remotecontrol');
await waitForSocketOpen(socket);

const results = [];
socket.send(`authwithtoken/${encodeURIComponent(token)}/${encodeURIComponent(username)}`);
results.push({ command: 'authwithtoken', response: await waitForTextResponse(socket) });

for (const command of ['answer', 'connect', 'call', 'start', 'mute/1', 'mute/0']) {
  socket.send(`jdev/sps/io/${encodeURIComponent(uuidAction)}/${encodeURIComponent(command).replaceAll('%2F', '/')}`);
  results.push({ command, response: await waitForTextResponse(socket) });
}

socket.close();
console.log(JSON.stringify({ wsUrl, results }, null, 2));
