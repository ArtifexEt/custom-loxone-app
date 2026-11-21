import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const publicDir = new URL('./public/', import.meta.url);

export default defineConfig({
  base: './',
  build: {
    // Older embedded browsers can run the app without newer syntax.
    target: ['chrome76', 'firefox75', 'safari13.1'],
  },
  plugins: [{
    name: 'precache-app-shell',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const index = bundle['index.html'];
      if (index?.type !== 'asset') {
        this.error('Missing HTML entry point for the service worker.');
      }
      const source = readFileSync(new URL('sw.js', publicDir), 'utf8');
      const hash = createHash('sha256').update(source);
      const assets = Object.keys(bundle).sort();
      for (const path of assets) {
        const output = bundle[path];
        hash.update(path).update(output.type === 'chunk' ? output.code : output.source);
      }
      const staticAssets = readdirSync(publicDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && entry.name !== 'sw.js')
        .map((entry) => entry.name)
        .sort();
      for (const path of staticAssets) {
        hash.update(path).update(readFileSync(new URL(path, publicDir)));
      }

      // The installed worker and its HTML always belong to the same build.
      const buildId = hash.digest('hex').slice(0, 16);
      const shell = `shell-${buildId}.html`;
      const precache = [shell, ...assets.filter((path) => path !== 'index.html'), ...staticAssets];
      this.emitFile({ type: 'asset', fileName: shell, source: index.source });
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: source
          .replace("'development'", JSON.stringify(buildId))
          .replace('const APP_ASSETS = [];', `const APP_ASSETS = ${JSON.stringify(precache)};`),
      });
    },
  }],
  server: {
    host: true,
    port: 4173,
  },
});
