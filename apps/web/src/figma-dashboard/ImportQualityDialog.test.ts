import { describe, expect, it } from 'vitest';
import { IMPORT_QUALITY_ACCEPT_LABEL, IMPORT_QUALITY_BACK_LABEL } from './ImportQualityDialog';

describe('import quality dialog actions', () => {
  it('keeps an explicit return action alongside the unchanged import action', () => {
    expect(IMPORT_QUALITY_BACK_LABEL).toBe('Вернуться');
    expect(IMPORT_QUALITY_ACCEPT_LABEL).toBe('Загрузить так');
    expect(IMPORT_QUALITY_BACK_LABEL).not.toBe('Продолжить');
  });
});
