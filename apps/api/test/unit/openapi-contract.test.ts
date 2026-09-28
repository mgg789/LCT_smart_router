import assert from 'node:assert/strict';
import test from 'node:test';
import document from '../../src/openapi/openapi.json';

/** Guards the generated public contract's validation and transport-specific edges. */
test('OpenAPI reflects runtime Zod constraints and inferred nested responses', () => {
  const login = document.paths['/api/v1/auth/login-code']?.post;
  const loginSchema = login?.requestBody?.content?.['application/json']?.schema;
  assert.equal(loginSchema?.properties?.email?.format, 'email');
  assert.deepEqual(loginSchema?.required, ['email']);
  assert.ok(login?.responses?.['201']);

  const requests = document.paths['/api/v1/dispatch/requests']?.get;
  const lifecycle =
    requests?.responses?.['200']?.content?.['application/json']?.schema?.properties?.requests?.items
      ?.properties?.lifecycle;
  assert.deepEqual(
    lifecycle?.anyOf?.map((item: { const: string }) => item.const).sort(),
    ['draft', 'submitted', 'in_progress', 'completed', 'cancelled'].sort(),
  );
  const healthChecks =
    document.paths['/health/ready']?.get?.responses?.['200']?.content?.['application/json']?.schema
      ?.properties?.checks;
  assert.equal(healthChecks?.type, 'object');
  assert.ok(healthChecks?.additionalProperties?.properties?.status);
});

test('OpenAPI keeps auth, SSE, PDF, MCP and prefix exceptions explicit', () => {
  assert.ok(document.paths['/health/ready']);
  assert.equal('/api/v1/health/ready' in document.paths, false);
  assert.ok(
    document.paths['/api/v1/ai/conversations/{id}/events']?.get?.responses?.['200']?.content?.[
      'text/event-stream'
    ],
  );
  assert.ok(
    document.paths['/api/v1/dispatch/reports/monthly/{month}']?.get?.responses?.['200']?.content?.[
      'application/pdf'
    ],
  );
  const mcp = document.paths['/api/v1/mcp']?.post;
  assert.deepEqual(mcp?.security, [{ bearerAuth: [] }, { mcpPin: [] }]);
  assert.ok(mcp?.responses?.['202']);
  assert.ok(
    mcp?.requestBody?.content?.['application/json']?.schema?.anyOf?.[1]?.items?.properties?.jsonrpc,
  );
  const events = document.paths['/api/v1/ai/conversations/{id}/events']?.get;
  assert.equal(events?.parameters?.[1]?.schema?.default, 0);
  assert.ok(events?.['x-event-data']);
  const chatData = events['x-event-data'].anyOf[0];
  assert.ok(chatData && 'anyOf' in chatData && chatData.anyOf);
  assert.deepEqual(
    chatData.anyOf.map((event) => event.properties.type.const).sort(),
    ['message', 'state'].sort(),
  );
});

test('OpenAPI exposes the actual media types of dispatcher downloads', () => {
  assert.ok(
    document.paths['/api/v1/dispatch/plan/export.xlsx']?.get?.responses?.['200']?.content?.[
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ],
  );
  assert.ok(
    document.paths['/api/v1/dispatch/data/requests/template.csv']?.get?.responses?.['200']
      ?.content?.['text/csv'],
  );
});
