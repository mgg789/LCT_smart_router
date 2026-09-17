import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Plugin } from 'vite';

/** Precache only this build's public app files; authenticated APIs are never intercepted/cached. */
export function offlineBundle(): Plugin {
  let output = '';
  return {
    name: 'navix-offline-shell',
    apply: 'build',
    configResolved(config) {
      output = config.build.outDir;
    },
    closeBundle() {
      const files: string[] = [];
      const visit = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) visit(path);
          else if (entry.name !== 'sw.js')
            files.push(`/${relative(output, path).replaceAll('\\', '/')}`);
        }
      };
      visit(output);
      files.sort();
      const hash = createHash('sha256');
      for (const file of files) hash.update(file).update(readFileSync(join(output, file.slice(1))));
      const cache = `navix-shell-${hash.digest('hex').slice(0, 16)}`;
      writeFileSync(
        join(output, 'sw.js'),
        `
const CACHE = ${JSON.stringify(cache)};
const FILES = ${JSON.stringify(files)};
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(response => { if (response.status >= 500) throw new Error('App gateway unavailable'); return response; }).catch(() => caches.open(CACHE).then(cache => cache.match('/index.html')).then(response => response || Response.error())));
  } else if (FILES.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(url.pathname)).then(response => response || fetch(event.request)));
  }
});
`,
        'utf-8',
      );
    },
  };
}
