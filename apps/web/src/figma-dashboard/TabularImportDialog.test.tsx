import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { TabularFieldControl } from './TabularImportDialog';

it('links selector labels explicitly and keeps datalist identifiers unchanged', () => {
  const html = renderToStaticMarkup(
    <TabularFieldControl label="Режим">
      <select defaultValue="append_requests">
        <option value="append_requests">Дополнить заявки</option>
      </select>
      <datalist id="regions">
        <option value="east" />
      </datalist>
    </TabularFieldControl>,
  );
  const labelId = html.match(/<label for="([^"]+)"/)?.[1];
  expect(labelId).toBeTruthy();
  expect(html).toContain(`<select id="${labelId}">`);
  expect(html).toContain('>Режим</label>');
  expect(html).toContain('<datalist id="regions">');
});
