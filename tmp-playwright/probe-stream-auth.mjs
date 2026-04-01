import fs from 'node:fs/promises';

const sourceFile = process.argv[2] ?? 'tmp-playwright/live-postpush.json';
const raw = await fs.readFile(sourceFile, 'utf8');
const payload = JSON.parse(raw);
const mediaSrc = payload?.summary?.mediaSrc;

if (!mediaSrc) {
  console.error('Missing summary.mediaSrc');
  process.exit(2);
}

const parsed = new URL(mediaSrc);
const token = parsed.searchParams.get('autht') || parsed.searchParams.get('auth');
if (!token) {
  console.error('Missing auth token in mediaSrc');
  process.exit(2);
}

parsed.username = '';
parsed.password = '';
parsed.search = '';
parsed.pathname = parsed.pathname.replace(/\/jpg\/image\.jpg$/, '/mjpg/video.mjpg');

const variants = [
  { name: 'autht', param: 'autht' },
  { name: 'auth', param: 'auth' },
];

const results = [];
for (const variant of variants) {
  const url = new URL(parsed.toString());
  url.searchParams.set(variant.param, token);
  const response = await fetch(url, { redirect: 'manual' });
  const contentType = response.headers.get('content-type') ?? '';
  let sample = '';
  try {
    const reader = response.body?.getReader();
    if (reader) {
      const chunk = await reader.read();
      if (!chunk.done && chunk.value) {
        sample = new TextDecoder().decode(chunk.value.slice(0, 80));
      }
      await reader.cancel().catch(() => {});
    }
  } catch {
    sample = '';
  }
  results.push({
    variant: variant.name,
    status: response.status,
    contentType,
    sample,
  });
}

console.log(JSON.stringify(results, null, 2));
