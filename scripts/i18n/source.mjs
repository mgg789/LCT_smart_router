import ts from 'typescript';

const readable = /[\p{L}]/u;
const russian = /[А-Яа-яЁё]/;
const visibleAttributes = new Set([
  'title',
  'alt',
  'placeholder',
  'aria-label',
  'label',
  'description',
  'emptyText',
  'text',
  'message',
  'summary',
  'header',
  'statusLabel',
  'workTypeTitle',
  'problemTitle',
]);
/** React's JSX whitespace normalization, preserving intentional spaces on one line. */
export function jsxText(text) {
  const lines = text.replace(/\t/g, ' ').split(/\r?\n/);
  let last = -1;
  lines.forEach((line, index) => {
    if (/[^ ]/.test(line)) last = index;
  });
  return lines
    .map((line, index) => {
      const value = index ? line.replace(/^ +/, '') : line;
      const trimmed = index < lines.length - 1 ? value.replace(/ +$/, '') : value;
      return trimmed ? trimmed + (index < last ? ' ' : '') : '';
    })
    .join('');
}
/** Finds authored display copy; syntax keys/types and regexes are protocol/data, never translated. */
export function messages(source, filename) {
  const ast = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const result = [];
  function visit(node) {
    if (ts.isJsxText(node)) {
      const value = jsxText(node.text);
      if (readable.test(value))
        result.push({ start: node.pos, end: node.end, value, kind: 'jsx', node });
      return;
    }
    if (
      ts.isTemplateExpression(node) &&
      russian.test(node.head.text + node.templateSpans.map((s) => s.literal.text).join(''))
    ) {
      let value = node.head.text;
      const params = [];
      node.templateSpans.forEach((span, index) => {
        const key = `value${index}`;
        value += `{{${key}}}${span.literal.text}`;
        params.push([key, span.expression.getText(ast)]);
      });
      result.push({
        start: node.getStart(ast),
        end: node.end,
        value,
        params,
        kind: 'expression',
        node,
      });
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent;
      if (
        ts.isLiteralTypeNode(parent) ||
        (parent.name === node && !ts.isJsxAttribute(parent)) ||
        ts.isImportDeclaration(parent) ||
        ts.isExportDeclaration(parent)
      )
        return;
      const attrNode = ts.isJsxAttribute(parent)
        ? parent
        : ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)
          ? parent.parent
          : null;
      const attr = attrNode?.name.getText(ast);
      const jsxCopy =
        ts.isJsxExpression(parent) &&
        (ts.isJsxElement(parent.parent) || ts.isJsxFragment(parent.parent));
      const property = ts.isPropertyAssignment(parent) ? parent.name.getText(ast) : null;
      const error = ts.isNewExpression(parent) && parent.expression.getText(ast) === 'Error';
      if (
        russian.test(node.text) ||
        (((attr && visibleAttributes.has(attr)) ||
          (property && visibleAttributes.has(property)) ||
          error ||
          jsxCopy) &&
          readable.test(node.text))
      ) {
        result.push({
          start: node.getStart(ast),
          end: node.end,
          value: node.text,
          kind: ts.isJsxAttribute(parent) ? 'attribute' : 'expression',
          node,
        });
      }
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { ast, messages: result };
}

/** Parse a data-only TS catalogue without executing its contents. */
export function readCatalog(text) {
  const ast = ts.createSourceFile('ru.ts', text, ts.ScriptTarget.Latest, true);
  if (ast.parseDiagnostics.length) throw new Error('Invalid catalogue syntax');
  const result = {};
  function visit(node) {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.initializer))
      result[node.name.text] = node.initializer.text;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return result;
}
