import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { transportLabel } from '../lib/reasons';
import { EngineerColumn } from './EngineerColumn';
import { MAIN_DASHBOARD } from './fixtures';

const noop = () => {};

describe('engineer sidebar transport icons', () => {
  it.each([
    ['car', 'transport-car.svg'],
    ['walk', 'transport-walk.svg'],
    ['bike', 'transport-bike.svg'],
    ['transit', 'transport-walk.svg'],
    ['unknown', null],
  ])('renders the icon for %s before the transport label', (transport, asset) => {
    const first = MAIN_DASHBOARD.engineers[0];
    if (!first) throw new Error('Engineer fixture missing');
    const label = transportLabel(transport);
    const html = renderToStaticMarkup(
      <EngineerColumn
        engineers={[{ ...first, transportType: transport, status: label }]}
        totalCount={1}
        requestCount={1}
        totalKm={0}
        planLabel="План"
        unassignedTitle="Без назначения"
        unassignedReason=""
        selectedEngineerId={null}
        searchOpen={false}
        searchQuery=""
        motionOn={false}
        onSearchToggle={noop}
        onSearchChange={noop}
        onSelect={noop}
        onSelectUnassigned={noop}
      />,
    );
    if (asset) {
      expect(html).toContain(`/figma/${asset}`);
      expect(html.indexOf(`/figma/${asset}`)).toBeLessThan(html.indexOf(`${label}</span>`));
      expect(html).toContain('aria-hidden="true"');
    } else {
      expect(html).not.toContain('/figma/transport-');
    }
    expect(html).toContain(`${label}</span>`);
  });
});
