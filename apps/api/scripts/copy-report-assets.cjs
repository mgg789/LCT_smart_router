const { copyFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');

// Keep PDF font rendering offline in the compiled API and test distributions.
const target = resolve(process.argv[2] || 'dist', 'src/notifications/assets');
mkdirSync(target, { recursive: true });
for (const file of ['report-regular.ttf', 'report-bold.ttf']) {
  copyFileSync(resolve('src/notifications/assets', file), resolve(target, file));
}

const openApiTarget = resolve(process.argv[2] || 'dist', 'src/openapi');
mkdirSync(openApiTarget, { recursive: true });
copyFileSync(resolve('src/openapi/openapi.json'), resolve(openApiTarget, 'openapi.json'));
