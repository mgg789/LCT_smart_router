import { describe, expect, it } from 'vitest';
import { DATA_UPLOAD_TITLE } from './DataUploadModal';

describe('Figma data upload dialog', () => {
  it('keeps the short MAIN title without the old caption', () => {
    expect(DATA_UPLOAD_TITLE).toBe('Загрузить данные');
    expect(DATA_UPLOAD_TITLE.length).toBeLessThan(24);
  });
});
