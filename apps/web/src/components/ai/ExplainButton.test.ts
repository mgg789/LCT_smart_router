import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExplainButton } from './ExplainButton';

describe('ExplainButton', () => {
  it('renders the scope it was given, for every explain site', () => {
    const request = renderToStaticMarkup(
      createElement(ExplainButton, {
        token: 'tok',
        target: { scope: 'request', requestId: 'r-1' },
      }),
    );
    expect(request).toContain('data-explain-scope="request"');

    const alert = renderToStaticMarkup(
      createElement(ExplainButton, {
        token: 'tok',
        target: { scope: 'alert', alertId: 'a-1' },
      }),
    );
    expect(alert).toContain('data-explain-scope="alert"');

    const policy = renderToStaticMarkup(
      createElement(ExplainButton, {
        token: 'tok',
        target: { scope: 'policy', policyId: 'compact' },
      }),
    );
    expect(policy).toContain('data-explain-scope="policy"');
  });

  it('disables the trigger without a token instead of faking a response', () => {
    const html = renderToStaticMarkup(
      createElement(ExplainButton, {
        token: null,
        target: { scope: 'engineer', engineerId: 'e-1' },
      }),
    );
    expect(html).toContain('data-explain-scope="engineer"');
    expect(html).toMatch(/<button[^>]*disabled=""/);
  });
});
