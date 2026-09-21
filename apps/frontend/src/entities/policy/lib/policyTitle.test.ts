import { describe, expect, it } from 'vitest';
import type { PoliciesView } from '../model/types';
import { activePolicyTitle, policyTitle } from './policyTitle';

describe('policyTitle', () => {
  it('renders the Russian name of a known preset, not the English label', () => {
    expect(policyTitle('compact', 'Compact')).toBe('Меньше инженеров');
    expect(policyTitle('sla', 'SLA safe')).toBe('Бережнее к окнам');
  });

  it('names `covering`, which the API returns but the contract doc omits', () => {
    expect(policyTitle('covering', 'Covering')).toBe('Полное покрытие');
  });

  it('falls back to the API label for a preset we have no name for', () => {
    expect(policyTitle('brand-new', 'Brand New')).toBe('Brand New');
  });

  it('falls back to the id when even the label is missing', () => {
    expect(policyTitle('brand-new')).toBe('brand-new');
  });
});

describe('activePolicyTitle', () => {
  it('names the preset that is in force', () => {
    const view: PoliciesView = {
      policies: [
        { policyId: 'fast', title: 'Fast', description: '', isDefault: false },
        { policyId: 'compact', title: 'Compact', description: '', isDefault: true },
      ],
      active: { policyId: 'compact', version: 1, changedAt: 1_789_829_462 },
    };

    expect(activePolicyTitle(view)).toBe('Меньше инженеров');
  });
});
