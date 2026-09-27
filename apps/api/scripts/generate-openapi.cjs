/*
 * Source-of-truth OpenAPI generator.  Nest's Swagger reflection cannot see Zod
 * pipes or structural return types, so this reads the controller AST and the
 * TypeScript checker.  Request schemas are loaded from the compiled DTO modules
 * and therefore retain the validation rules the HTTP boundary actually uses.
 */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { z } = require('zod');

const root = path.resolve(__dirname, '..');
const sourceRoot = path.join(root, 'src');
const output = path.join(sourceRoot, 'openapi', 'openapi.json');
const check = process.argv.includes('--check');
const controllers = walk(sourceRoot).filter((file) => file.endsWith('.controller.ts'));

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

function decoratorName(decorator) {
  const expression = decorator.expression;
  return ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
    ? expression.expression.text
    : undefined;
}
function decoratorArg(decorator, index = 0) {
  const expression = decorator.expression;
  return ts.isCallExpression(expression) ? expression.arguments[index] : undefined;
}
function text(node) {
  return node ? node.getText() : undefined;
}
function stringArg(decorator) {
  const arg = decoratorArg(decorator);
  return arg && ts.isStringLiteralLike(arg) ? arg.text : '';
}
function decorators(node) {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) || [] : [];
}
function hasDecorator(node, name) {
  return decorators(node).some((item) => decoratorName(item) === name);
}

function loadSchemas(checker) {
  const dist = path.join(root, 'dist', 'src');
  if (!fs.existsSync(dist))
    throw new Error('Compiled API modules are missing; run pnpm --filter api build first.');
  return { checker };
}

function schemaForZodExpression(expression, schemas) {
  if (ts.isIdentifier(expression)) {
    const source = expression.getSourceFile();
    const symbol = schemas.checker.getSymbolAtLocation(expression);
    if (symbol?.flags & ts.SymbolFlags.Alias) {
      // Resolve through barrel re-exports without executing their Nest modules.
      // Importing a barrel may eagerly validate deployment env during a clean build.
      const actual = schemas.checker.getAliasedSymbol(symbol);
      const declaration = actual.valueDeclaration;
      if (!declaration) throw new Error(`Missing runtime schema declaration: ${expression.text}`);
      const relative = path.relative(sourceRoot, declaration.getSourceFile().fileName);
      if (relative.startsWith('..'))
        throw new Error(`Schema outside API source: ${expression.text}`);
      const imported = require(path.join(root, 'dist', 'src', relative.replace(/\.ts$/, '.js')));
      const value = imported[actual.getName()];
      if (value && '_zod' in value) return value;
      throw new Error(`Missing compiled Zod export: ${actual.getName()}`);
    }
    const declaration = source.statements.find(
      (statement) =>
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(
          (item) => ts.isIdentifier(item.name) && item.name.text === expression.text,
        ),
    );
    const variable = declaration?.declarationList.declarations.find(
      (item) => ts.isIdentifier(item.name) && item.name.text === expression.text,
    );
    return variable?.initializer ? evaluateLocalZod(variable.initializer) : undefined;
  }
  // A few endpoints add an operationId at the controller boundary. Preserve that
  // runtime rule instead of silently downgrading it to an unconstrained object.
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'extend' &&
    ts.isIdentifier(expression.expression.expression)
  ) {
    const base = schemaForZodExpression(expression.expression.expression, schemas);
    const object = expression.arguments[0];
    if (!base || !object || !ts.isObjectLiteralExpression(object)) return undefined;
    const shape = {};
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return undefined;
      const initializer = property.initializer;
      if (
        ts.isCallExpression(initializer) &&
        ts.isPropertyAccessExpression(initializer.expression) &&
        ts.isIdentifier(initializer.expression.expression) &&
        initializer.expression.expression.text === 'z'
      ) {
        const method = initializer.expression.name.text;
        if (method === 'uuid') shape[property.name.text] = z.uuid();
        else if (method === 'string') shape[property.name.text] = z.string();
        else return undefined;
      } else return undefined;
    }
    return base.extend(shape);
  }
  return undefined;
}

/** Evaluates the small local Zod subset used directly in a controller. */
function evaluateLocalZod(node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const receiver = node.expression.expression;
    const method = node.expression.name.text;
    const args = node.arguments.map(evaluateLocalZod);
    if (ts.isIdentifier(receiver) && receiver.text === 'z') {
      if (
        method === 'object' &&
        node.arguments[0] &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        const shape = {};
        for (const property of node.arguments[0].properties) {
          if (!ts.isPropertyAssignment(property)) return undefined;
          shape[property.name.getText()] = evaluateLocalZod(property.initializer);
        }
        return z.object(shape);
      }
      if (method === 'uuid') return z.uuid();
      if (method === 'string') return z.string();
      if (method === 'number') return z.number();
      if (method === 'boolean') return z.boolean();
    }
    const target = evaluateLocalZod(receiver);
    if (target && typeof target[method] === 'function') return target[method](...args);
  }
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  return undefined;
}

function jsonSchema(schema, context) {
  if (!schema) throw new Error(`Cannot resolve runtime Zod schema for ${context}`);
  return z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' });
}

function typeSchema(checker, type, seen = new Set()) {
  const printable = checker.typeToString(type);
  const typeSymbol = type.getSymbol();
  const typeName = typeSymbol && checker.symbolToString(typeSymbol);
  if (type.flags & ts.TypeFlags.Any || type.flags & ts.TypeFlags.Unknown) return {};
  const aliasName = type.aliasSymbol && checker.symbolToString(type.aliasSymbol);
  // Prisma's JSON aliases are intentionally unbounded fields. Do not inspect the
  // printable type here: a containing response can mention JsonValue while still
  // having other fields that must remain visible in the contract.
  if (
    aliasName === 'JsonValue' ||
    aliasName === 'InputJsonValue' ||
    aliasName === 'JsonObject' ||
    aliasName === 'InputJsonObject' ||
    aliasName === 'JsonArray' ||
    aliasName === 'InputJsonArray' ||
    typeName === 'JsonValue' ||
    typeName === 'InputJsonValue' ||
    typeName === 'JsonObject' ||
    typeName === 'InputJsonObject' ||
    typeName === 'JsonArray' ||
    typeName === 'InputJsonArray'
  )
    return {};
  if (type.flags & ts.TypeFlags.Never) return { not: {} };
  if (type.isStringLiteral?.()) return { const: type.value, type: 'string' };
  if (type.isNumberLiteral?.()) return { const: type.value, type: 'number' };
  if (type.flags & ts.TypeFlags.StringLike) return { type: 'string' };
  if (type.flags & ts.TypeFlags.NumberLike) return { type: 'number' };
  if (type.flags & ts.TypeFlags.BooleanLike) return { type: 'boolean' };
  if (type.flags & ts.TypeFlags.BigIntLike)
    throw new Error('BigInt cannot cross the JSON response boundary');
  if (type.flags & ts.TypeFlags.Null) return { type: 'null' };
  if (type.flags & ts.TypeFlags.Undefined || type.flags & ts.TypeFlags.Void) return { not: {} };
  if (type.isUnion?.()) {
    const values = type.types.filter((item) => !(item.flags & ts.TypeFlags.Undefined));
    return values.length === 1
      ? typeSchema(checker, values[0], seen)
      : { anyOf: values.map((item) => typeSchema(checker, item, seen)) };
  }
  if (type.isIntersection?.())
    return { allOf: type.types.map((item) => typeSchema(checker, item, seen)) };
  const symbol = type.getSymbol();
  const name = symbol && checker.symbolToString(symbol);
  if (name === 'Date' || printable === 'Date') return { type: 'string', format: 'date-time' };
  const reference = type;
  const args = checker.getTypeArguments(reference);
  if (printable.startsWith('Record<') && args[1])
    return { type: 'object', additionalProperties: typeSchema(checker, args[1], seen) };
  if (
    checker.isArrayType(type) ||
    checker.isTupleType(type) ||
    name === 'Array' ||
    name === 'ReadonlyArray' ||
    name === 'Set'
  ) {
    const item = args[0];
    return { type: 'array', items: item ? typeSchema(checker, item, seen) : {} };
  }
  const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  const properties = checker.getPropertiesOfType(type);
  const typeId = type.id;
  if (seen.has(typeId))
    throw new Error(`Recursive response type ${name || printable} needs an explicit JSON field`);
  if (properties.length || index) {
    const nextSeen = new Set(seen);
    nextSeen.add(typeId);
    const required = [];
    const result = { type: 'object', properties: {} };
    for (const property of properties) {
      const declaration = property.valueDeclaration || property.declarations?.[0];
      if (!declaration) continue;
      result.properties[property.getName()] = typeSchema(
        checker,
        checker.getTypeOfSymbolAtLocation(property, declaration),
        nextSeen,
      );
      if (!(property.flags & ts.SymbolFlags.Optional)) required.push(property.getName());
    }
    if (index) result.additionalProperties = typeSchema(checker, index, nextSeen);
    if (required.length) result.required = required;
    return result;
  }
  throw new Error(`Unsupported response type: ${checker.typeToString(type)}`);
}

function unwrapReturn(checker, method) {
  const signature = checker.getSignatureFromDeclaration(method);
  if (!signature) throw new Error(`No signature for ${method.name.getText()}`);
  let type = checker.getReturnTypeOfSignature(signature);
  const symbol = type.getSymbol();
  const name = symbol && checker.symbolToString(symbol);
  if (name === 'Promise' || name === 'Observable') type = checker.getTypeArguments(type)[0] || type;
  return type;
}

function operationSummary(method) {
  const decorator = decorators(method).find((item) => decoratorName(item) === 'ApiOperation');
  const arg = decorator && decoratorArg(decorator);
  if (!arg || !ts.isObjectLiteralExpression(arg)) return undefined;
  const summary = arg.properties.find(
    (property) => ts.isPropertyAssignment(property) && text(property.name) === 'summary',
  );
  return summary && ts.isPropertyAssignment(summary) && ts.isStringLiteralLike(summary.initializer)
    ? summary.initializer.text
    : undefined;
}
function declaredTypeSchema(file, checker, name) {
  for (const statement of file.statements) {
    if (
      (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
      statement.name.text === name
    )
      return typeSchema(checker, checker.getTypeAtLocation(statement.name));
  }
  throw new Error(`Cannot resolve declared SSE event type ${name}`);
}
function pathParameters(method, checker, schemas) {
  const result = [];
  const requiredQueries = new Set();
  for (const decorator of decorators(method)) {
    if (decoratorName(decorator) !== 'ApiQuery') continue;
    const argument = decoratorArg(decorator);
    if (!argument || !ts.isObjectLiteralExpression(argument)) continue;
    const name = argument.properties.find(
      (property) => ts.isPropertyAssignment(property) && property.name.getText() === 'name',
    );
    const required = argument.properties.find(
      (property) => ts.isPropertyAssignment(property) && property.name.getText() === 'required',
    );
    if (
      name &&
      required &&
      ts.isPropertyAssignment(name) &&
      ts.isPropertyAssignment(required) &&
      ts.isStringLiteralLike(name.initializer) &&
      required.initializer.kind === ts.SyntaxKind.TrueKeyword
    )
      requiredQueries.add(name.initializer.text);
  }
  for (const parameter of method.parameters) {
    for (const decorator of decorators(parameter)) {
      const name = decoratorName(decorator);
      if (name === 'Param') {
        const value = stringArg(decorator);
        if (value)
          result.push({ name: value, in: 'path', required: true, schema: { type: 'string' } });
      }
      if (name === 'Query') {
        const value = stringArg(decorator);
        if (value)
          result.push({
            name: value,
            in: 'query',
            required: requiredQueries.has(value),
            schema: { type: 'string' },
          });
        else {
          const pipe = decoratorArg(decorator);
          if (
            pipe &&
            ts.isCallExpression(pipe) &&
            ts.isIdentifier(pipe.expression) &&
            pipe.expression.text === 'zodBody'
          ) {
            const input = jsonSchema(
              schemaForZodExpression(pipe.arguments[0], schemas),
              `${method.name.getText()} query`,
            );
            for (const [key, value] of Object.entries(input.properties || {}))
              result.push({
                name: key,
                in: 'query',
                required: (input.required || []).includes(key),
                schema: value,
              });
            continue;
          }
          const type = checker.getTypeAtLocation(parameter);
          for (const property of checker.getPropertiesOfType(type)) {
            const declaration = property.valueDeclaration || property.declarations?.[0];
            if (!declaration) continue;
            result.push({
              name: property.getName(),
              in: 'query',
              required: !(property.flags & ts.SymbolFlags.Optional),
              schema: typeSchema(checker, checker.getTypeOfSymbolAtLocation(property, declaration)),
            });
          }
        }
      }
    }
  }
  return result;
}
function requestBody(method, schemas, checker) {
  for (const parameter of method.parameters)
    for (const decorator of decorators(parameter)) {
      if (decoratorName(decorator) !== 'Body') continue;
      const pipe = decoratorArg(decorator);
      if (
        pipe &&
        ts.isCallExpression(pipe) &&
        ts.isIdentifier(pipe.expression) &&
        pipe.expression.text === 'zodBody'
      ) {
        return {
          required: true,
          content: {
            'application/json': {
              schema: jsonSchema(
                schemaForZodExpression(pipe.arguments[0], schemas),
                method.name.getText(),
              ),
            },
          },
        };
      }
      return {
        required: true,
        content: {
          'application/json': { schema: typeSchema(checker, checker.getTypeAtLocation(parameter)) },
        },
      };
    }
}

const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'details', 'requestId'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: {},
        requestId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    },
  },
};
const jsonRpcId = { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] };
const jsonRpcRequest = {
  type: 'object',
  required: ['jsonrpc', 'method'],
  properties: {
    jsonrpc: { const: '2.0', type: 'string' },
    method: { type: 'string' },
    params: {},
    id: jsonRpcId,
  },
};
const jsonRpcSuccess = {
  type: 'object',
  required: ['jsonrpc', 'id', 'result'],
  properties: { jsonrpc: { const: '2.0', type: 'string' }, id: jsonRpcId, result: {} },
};
const jsonRpcFailure = {
  type: 'object',
  required: ['jsonrpc', 'id', 'error'],
  properties: {
    jsonrpc: { const: '2.0', type: 'string' },
    id: jsonRpcId,
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: { code: { type: 'number' }, message: { type: 'string' }, data: {} },
    },
  },
};
const jsonRpcReply = { anyOf: [jsonRpcSuccess, jsonRpcFailure] };
const mcpMethodError = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { const: 'METHOD_NOT_ALLOWED', type: 'string' },
        message: { type: 'string' },
      },
    },
  },
};
function errors() {
  return Object.fromEntries(
    [400, 401, 403, 404, 409, 429, 500].map((status) => [
      status,
      { description: 'Ошибка API', content: { 'application/json': { schema: errorSchema } } },
    ]),
  );
}

function main() {
  const config = ts.readConfigFile(path.join(root, 'tsconfig.build.json'), ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  parsed.fileNames.push(...controllers);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const schemas = loadSchemas(checker);
  const { HTTP_CONTRACT: httpContract } = require(
    path.join(root, 'dist', 'src', 'common', 'http-contract'),
  );
  const document = {
    openapi: '3.1.0',
    info: {
      title: 'LCT Smart Router — System Layer',
      version: '0.1.0',
      description:
        'Контракт System Layer. Генерируется из Nest-контроллеров, TypeScript и runtime Zod-схем.',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'session or integration token',
        },
        mcpPin: { type: 'apiKey', in: 'header', name: 'X-MCP-Pin' },
      },
    },
    paths: {},
  };
  for (const fileName of controllers.sort()) {
    const file = program.getSourceFile(fileName);
    if (!file) continue;
    for (const statement of file.statements)
      if (ts.isClassDeclaration(statement)) {
        const controller = decorators(statement).find(
          (item) => decoratorName(item) === 'Controller',
        );
        if (!controller) continue;
        const base = stringArg(controller);
        const publicController = hasDecorator(statement, 'Public');
        const controllerRoles = decorators(statement).find(
          (item) => decoratorName(item) === 'Roles',
        );
        const tagDecorator = decorators(statement).find(
          (item) => decoratorName(item) === 'ApiTags',
        );
        const tags = tagDecorator
          ? tagDecorator.expression.arguments.map((arg) =>
              ts.isStringLiteralLike(arg) ? arg.text : text(arg),
            )
          : [];
        for (const member of statement.members)
          if (ts.isMethodDeclaration(member) && member.name) {
            const route = decorators(member).find((item) =>
              ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Sse'].includes(decoratorName(item)),
            );
            if (!route) continue;
            const verbName = decoratorName(route);
            const routeArgument = decoratorArg(route);
            if (routeArgument && !ts.isStringLiteralLike(routeArgument))
              throw new Error(
                `${fileName}:${member.name.getText()}: route decorator must use a string literal`,
              );
            const methodPath = stringArg(route);
            const unprefixedPath = `/${[base, methodPath].filter(Boolean).join('/')}`;
            const prefix = httpContract.exclude.includes(unprefixedPath.slice(1))
              ? ''
              : `/${httpContract.prefix}`;
            const routePath = `${prefix}/${[base, methodPath].filter(Boolean).join('/')}`
              .replace(/\/+/g, '/')
              .replace(/:([^/]+)/g, '{$1}');
            const verb = verbName === 'Sse' ? 'get' : verbName.toLowerCase();
            const httpCode = decorators(member).find((item) => decoratorName(item) === 'HttpCode');
            const httpCodeArgument = httpCode && decoratorArg(httpCode);
            if (httpCodeArgument && !ts.isNumericLiteral(httpCodeArgument))
              throw new Error(
                `${fileName}:${member.name.getText()}: HttpCode must use a numeric literal`,
              );
            const successStatus = httpCodeArgument
              ? httpCodeArgument.text
              : verb === 'post'
                ? '201'
                : '200';
            // Nest applies only the outermost duplicate route decorator. Keep this in the
            // contract so /data/road-import cannot accidentally advertise a dead alias.
            const allRouteDecorators = decorators(member).filter((item) =>
              ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Sse'].includes(decoratorName(item)),
            );
            if (allRouteDecorators[0] !== route) continue;
            const response = {};
            if (verbName === 'Sse')
              response['200'] = {
                description: 'Server-sent events',
                content: { 'text/event-stream': { schema: { type: 'string' } } },
              };
            else if (member.type?.getText().includes('StreamableFile'))
              response['200'] = {
                description: 'PDF report',
                content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
              };
            else if (fileName.endsWith(path.join('mcp', 'mcp.controller.ts'))) {
              if (verb === 'post') {
                response['200'] = {
                  description: 'MCP JSON-RPC response',
                  content: {
                    'application/json': {
                      schema: { anyOf: [jsonRpcReply, { type: 'array', items: jsonRpcReply }] },
                    },
                  },
                };
                response['400'] = {
                  description: 'Malformed JSON body',
                  content: { 'application/json': { schema: jsonRpcFailure } },
                };
                response['202'] = { description: 'JSON-RPC notification accepted' };
              } else
                response['405'] = {
                  description: 'MCP transport does not offer this method',
                  content: { 'application/json': { schema: mcpMethodError } },
                };
            } else {
              try {
                const returnType = unwrapReturn(checker, member);
                if (returnType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
                  throw new Error('Top-level response type must not be any or unknown');
                response[successStatus] = {
                  description: 'Успешный ответ',
                  content: {
                    'application/json': {
                      schema: typeSchema(checker, returnType),
                    },
                  },
                };
              } catch (error) {
                throw new Error(`${fileName}:${member.name.getText()}: ${error.message}`);
              }
            }
            Object.assign(response, errors());
            if (fileName.endsWith(path.join('mcp', 'mcp.controller.ts')) && verb === 'post')
              response['400'] = {
                description: 'Malformed JSON body',
                content: { 'application/json': { schema: jsonRpcFailure } },
              };
            if (routePath === '/health/ready' && response['200']) response['503'] = response['200'];
            const methodRoles = decorators(member).find((item) => decoratorName(item) === 'Roles');
            const roleDecorator = methodRoles || controllerRoles;
            const roleValues = roleDecorator
              ? roleDecorator.expression.arguments.map((arg) => text(arg).replaceAll("'", ''))
              : [];
            const operation = {
              operationId: `${statement.name ? statement.name.text : 'controller'}_${member.name.getText()}`,
              summary: operationSummary(member),
              tags,
              parameters: pathParameters(member, checker, schemas),
              responses: response,
            };
            if (verbName === 'Sse') {
              const eventType =
                base === 'ai' && methodPath === 'runs/:runId/events'
                  ? 'AiRunEvent'
                  : (base === 'ai' && methodPath === 'conversations/:id/events') ||
                      (base === 'dispatch' && methodPath === 'chats/events')
                    ? 'ChatStreamEvent'
                    : undefined;
              if (!eventType) throw new Error(`Undocumented SSE event contract: ${routePath}`);
              const eventSource = program.getSourceFile(
                path.join(
                  sourceRoot,
                  eventType === 'AiRunEvent'
                    ? 'ai/runtime/ai-event.types.ts'
                    : 'api/chat-stream.ts',
                ),
              );
              if (!eventSource) throw new Error(`Missing SSE contract ${eventType}`);
              operation['x-event-data'] = {
                anyOf: [
                  declaredTypeSchema(eventSource, checker, eventType),
                  {
                    type: 'object',
                    maxProperties: 0,
                    description: 'Empty data payload of the heartbeat SSE event.',
                  },
                ],
              };
            }
            const body = requestBody(member, schemas, checker);
            if (body) operation.requestBody = body;
            const isMcp = fileName.endsWith(path.join('mcp', 'mcp.controller.ts'));
            if (isMcp && verb === 'post')
              operation.requestBody = {
                required: true,
                content: {
                  'application/json': {
                    schema: {
                      anyOf: [
                        jsonRpcRequest,
                        { type: 'array', minItems: 1, items: jsonRpcRequest },
                      ],
                    },
                  },
                },
              };
            if (!operation.summary) delete operation.summary;
            if (!operation.tags.length) delete operation.tags;
            if (!operation.parameters.length) delete operation.parameters;
            const publicMethod = publicController || hasDecorator(member, 'Public');
            if (isMcp && verb === 'post') operation.security = [{ bearerAuth: [] }, { mcpPin: [] }];
            else if (!publicMethod) operation.security = [{ bearerAuth: [] }];
            if (roleValues.length) operation['x-required-roles'] = roleValues;
            document.paths[routePath] ||= {};
            document.paths[routePath][verb] = operation;
          }
      }
  }
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (check) {
    if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== serialized)
      throw new Error(
        `OpenAPI drift: run pnpm --filter api openapi:generate and commit ${path.relative(root, output)}.`,
      );
    return;
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, serialized);
}
main();
