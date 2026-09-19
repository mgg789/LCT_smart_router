import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyableValue, copyText } from './copyText';

describe('copyText', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  it('falls back to execCommand when clipboard.writeText is missing', async () => {
    const exec = vi.fn().mockReturnValue(true);
    const field = {
      value: '',
      style: { position: '', left: '' },
      setAttribute: vi.fn(),
      select: vi.fn(),
    };
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', {
      createElement: () => field,
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      execCommand: exec,
    });
    expect(await copyText('50104')).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    expect(field.value).toBe('50104');
  });
});
