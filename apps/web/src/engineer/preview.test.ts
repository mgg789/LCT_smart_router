import { describe, expect, it } from 'vitest';
import { recordedScenario } from '../demo/scenarios';
import {
  buildEngineerPreview,
  findEngineerPreview,
  localEngineerEmail,
  writeEngineerRoster,
} from './preview';

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
}

describe('local engineer preview from the dispatcher day', () => {
  it('gives a demo address to a brigade without a login and keeps a real one', () => {
    expect(localEngineerEmail({ id: 'e1', displayName: 'Бригада 1', email: null })).toBe(
      'бригада.1@demo.local',
    );
    expect(
      localEngineerEmail({ id: 'e1', displayName: 'Бригада 1', email: 'crew@example.test' }),
    ).toBe('crew@example.test');
  });

  it('lets the dispatcher open any recorded crew by that address', () => {
    const snapshot = recordedScenario('initial').snapshot;
    const first = snapshot.engineers[0];
    expect(first).toBeDefined();
    if (!first) {
      return;
    }
    const preview = buildEngineerPreview(snapshot, first.id);
    expect(preview?.profile.displayName).toBe(first.displayName);
    expect(preview?.profile.email).toBe(localEngineerEmail(first));
    expect(preview?.plan.route?.engineerId ?? null).toBe(
      snapshot.plan.plan?.routes.find((route) => route.engineerId === first.id)?.engineerId ?? null,
    );

    const store = storage();
    writeEngineerRoster(store, snapshot);
    const found = findEngineerPreview(store, localEngineerEmail(first));
    expect(found?.profile.id).toBe(first.id);
    expect(found?.plan.requests.every((request) => request.id.length > 0)).toBe(true);
  });
});
