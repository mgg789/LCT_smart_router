import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { messages, readCatalog } from './source.mjs';

const root = path.resolve('apps/web/src');
const catalogue = readCatalog(fs.readFileSync(path.join(root, 'i18n/ru.ts'), 'utf8'));
const issues = [];
let files = 0;
function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
for (const file of walk(root)) {
  if (!/\.tsx?$/.test(file) || /\.(test|spec)\./.test(file) || file.includes('/i18n/')) continue;
  files++;
  const source = fs.readFileSync(file, 'utf8');
  const found = messages(source, file);
  const report = (position, message) => {
    const at = found.ast.getLineAndCharacterOfPosition(position);
    issues.push(
      `${path.relative(process.cwd(), file)}:${at.line + 1}:${at.character + 1} ${message}`,
    );
  };
  for (const item of found.messages)
    report(item.start, 'User-facing copy must use the i18n catalogue.');
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 't'
    ) {
      const key = node.arguments[0];
      if (!key || !ts.isStringLiteral(key))
        report(node.getStart(), 'Translation keys must be statically verifiable.');
      else if (!(key.text in catalogue))
        report(key.getStart(), `Unknown translation key: ${key.text}`);
      else {
        const params = [...catalogue[key.text].matchAll(/{{(\w+)}}/g)].map((m) => m[1]);
        const supplied = node.arguments[1];
        if (params.length && !supplied)
          report(node.getStart(), 'Missing translation interpolation values.');
        if (supplied && ts.isObjectLiteralExpression(supplied)) {
          const names = new Set(
            supplied.properties.map((p) => p.name?.getText(found.ast).replace(/^['"]|['"]$/g, '')),
          );
          for (const param of params)
            if (!names.has(param)) report(node.getStart(), `Missing interpolation value: ${param}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(found.ast);
}
if (issues.length) {
  console.error(issues.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `i18n: ${files} source files checked, ${Object.keys(catalogue).length} Russian messages; no inline copy or invalid keys.`,
  );
