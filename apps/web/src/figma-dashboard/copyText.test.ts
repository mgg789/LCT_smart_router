import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyableValue, copyText } from './copyText';

describe('copyText', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('skips empty, whitespace and em-dash placeholders', () => {
    expect(copyableValue(null)).toBeNull();
    expect(copyableValue('')).toBeNull();
    expect(copyableValue('   ')).toBeNull();
    expect(copyableValue('—')).toBeNull();
    expect(copyableValue('  4400b62a  ')).toBe('4400b62a');
  });

  it('writes only the trimmed value', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyText('  4400b62a  ')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('4400b62a');
    expect(await copyText('—')).toBe(false);
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});
