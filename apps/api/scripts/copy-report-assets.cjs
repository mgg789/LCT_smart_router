const { copyFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');

// Keep PDF font rendering offline in the compiled API and test distributions.
const target = resolve(process.argv[2] || 'dist', 'src/notifications/assets');
mkdirSync(target, { recursive: true });
for (const file of ['report-regular.ttf', 'report-bold.ttf']) {
  copyFileSync(resolve('src/notifications/assets', file), resolve(target, file));
}
