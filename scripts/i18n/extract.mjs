import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { messages, readCatalog } from './source.mjs';

const root = path.resolve('apps/web/src');
const ruFile = path.join(root, 'i18n/ru.ts');
const old = fs.readFileSync(ruFile, 'utf8');
const catalog = readCatalog(old);
const ignored = new Set(process.argv.slice(2));
function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
let files = 0,
  total = 0;
for (const file of walk(root)) {
  if (
    !/\.tsx?$/.test(file) ||
    /\.(test|spec)\./.test(file) ||
    file.includes('/i18n/') ||
    ignored.has(path.relative(root, file))
  )
    continue;
  let text = fs.readFileSync(file, 'utf8'),
    changed = false;
  // Repeat only for nested message expressions inside interpolated templates.
  for (let pass = 0; pass < 6; pass++) {
    const found = messages(text, file).messages;
    if (!found.length) break;
    const edits = found.map((m) => {
      const key =
        path
          .relative(root, file)
          .replace(/\.tsx?$/, '')
          .replaceAll('/', '.') +
        '.' +
        createHash('sha256').update(m.value).digest('hex').slice(0, 10);
      catalog[key] = m.value;
      const args = m.params?.length
        ? `, { ${m.params.map(([k, v]) => `${k}: (${v})`).join(', ')} }`
        : '';
      const call = `t(${JSON.stringify(key)}${args})`;
      return { ...m, replacement: m.kind === 'expression' ? call : `{${call}}` };
    });
    for (const e of edits.sort((a, b) => b.start - a.start))
      text = text.slice(0, e.start) + e.replacement + text.slice(e.end);
    changed = true;
    total += edits.length;
  }
  if (changed) {
    let relative = path
      .relative(path.dirname(file), path.join(root, 'i18n'))
      .replaceAll(path.sep, '/');
    if (!relative.startsWith('.')) relative = `./${relative}`;
    if (!text.includes(`from '${relative}'`) && !text.includes(`from "${relative}"`))
      text = `import { t } from '${relative}';\n${text}`;
    fs.writeFileSync(file, text);
    files++;
  }
}
fs.writeFileSync(
  ruFile,
  '/** Russian source catalogue. Keys are stable, namespaced by source module. */\nexport const ru = ' +
    JSON.stringify(catalog, null, 2) +
    ' as const;\n',
);
console.log(JSON.stringify({ files, messages: total, keys: Object.keys(catalog).length }));
