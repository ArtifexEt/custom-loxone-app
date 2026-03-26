# Repository Instructions

## Session Memory

- Before doing substantial work, read [PROJECT_MEMORY.md](./PROJECT_MEMORY.md).
- After every substantive task, update [PROJECT_MEMORY.md](./PROJECT_MEMORY.md):
  - what changed
  - key technical decisions
  - important constraints or caveats
  - next likely steps if they became clearer
- Keep memory concise and high-signal. Prefer updating existing sections over dumping logs.

## Secrets

- Never store real credentials, tokens, server IPs, private URLs, or other secrets in repository files.
- If a note needs to mention runtime configuration, use placeholders only.

## Current Project Intent

- This repository contains a worker-first PWA for Loxone.
- Main thread should stay thin: UI rendering and media elements only.
- State, storage, websocket communication, reconnect logic, and view orchestration should stay in the Web Worker.
- The app must remain configurable by end users from within the UI.
