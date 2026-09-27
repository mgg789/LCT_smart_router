import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  findWorkType,
  findWorkTypeByTitle,
  fitWindowToService,
  importedWorkCategory,
  WORK_NORM_PROFILES,
  WORK_TYPES,
} from '../../src/orchestrator/requests/work-type.catalog';

const EXPECTED_MAPPING = {
  connection_base: ['connection_request', 'convergence', 'gigabit_switch'],
  network_emergency: ['outage'],
  outage_tkd: ['no_link', 'disconnects', 'low_speed', 'port_errors', 'ip_169'],
  equipment_order: ['equipment_order', 'router_replacement', 'stb_replacement'],
  local_repair: ['cable_work', 'monitoring', 'other_errors', 'information'],
} as const;

describe('work type normative catalogue', () => {
  it('keeps business priority separate from qualification and preserves unknown type classification', () => {
    assert.equal(findWorkType('outage')?.category, 'emergency');
    assert.equal(findWorkType('no_link')?.category, 'service');
    assert.equal(findWorkType('no_link')?.skill, 'emergency');
    assert.equal(findWorkType('equipment_order')?.category, 'service');
    for (const code of ['connection_request', 'convergence', 'gigabit_switch']) {
      assert.equal(findWorkType(code)?.category, 'connection');
    }
    assert.equal(
      importedWorkCategory({ workType: 'New vendor type', priority: 'urgent' }),
      undefined,
    );
    assert.equal(
      importedWorkCategory({
        workType: 'New vendor type',
        workCategory: 'connection',
        priority: 'normal',
      }),
      'connection',
    );
    assert.equal(
      importedWorkCategory({ workType: 'Авария', workCategory: 'service', priority: 'normal' }),
      'emergency',
    );
  });

  it('exports exactly the same catalogue to the offline Router importer', () => {
    const exported = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../../core/work-types.json'), 'utf8'),
    );
    assert.deepEqual(exported, WORK_TYPES);
  });

  it('maps every supported work type to exactly one canonical norm', () => {
    const expectedCodes = Object.values(EXPECTED_MAPPING).flat().sort();
    const actualCodes = WORK_TYPES.map((item) => item.code).sort();

    assert.equal(new Set(actualCodes).size, 16);
    assert.deepEqual(actualCodes, expectedCodes);

    for (const [profileCode, workTypeCodes] of Object.entries(EXPECTED_MAPPING)) {
      for (const workTypeCode of workTypeCodes) {
        assert.equal(findWorkType(workTypeCode)?.normProfileCode, profileCode);
      }
    }
  });

  it('keeps reference travel separate from on-site service duration', () => {
    assert.deepEqual(WORK_NORM_PROFILES, {
      connection_base: {
        normProfileCode: 'connection_base',
        normativeTravelDurationSec: 1200,
        technicalDurationSec: 3600,
        documentationDurationSec: 600,
        serviceDurationSec: 4200,
      },
      network_emergency: {
        normProfileCode: 'network_emergency',
        normativeTravelDurationSec: 1200,
        technicalDurationSec: 6000,
        documentationDurationSec: 0,
        serviceDurationSec: 6000,
      },
      outage_tkd: {
        normProfileCode: 'outage_tkd',
        normativeTravelDurationSec: 1200,
        technicalDurationSec: 4800,
        documentationDurationSec: 0,
        serviceDurationSec: 4800,
      },
      equipment_order: {
        normProfileCode: 'equipment_order',
        normativeTravelDurationSec: 1200,
        technicalDurationSec: 600,
        documentationDurationSec: 600,
        serviceDurationSec: 1200,
      },
      local_repair: {
        normProfileCode: 'local_repair',
        normativeTravelDurationSec: 1200,
        technicalDurationSec: 1800,
        documentationDurationSec: 0,
        serviceDurationSec: 1800,
      },
    });

    for (const profile of Object.values(WORK_NORM_PROFILES)) {
      assert.equal(
        profile.serviceDurationSec,
        profile.technicalDurationSec + profile.documentationDurationSec,
      );
      assert.equal(profile.normativeTravelDurationSec, 1200);
    }
  });

  it('matches every official Core scenario skill derivation', () => {
    const scenariosRoot = resolve(__dirname, '..', '..', '..', '..', '..', 'core', 'scenarios');
    for (const scenario of ['east-v1', 'southeast-v1', 'south-central-v1']) {
      const config = JSON.parse(
        readFileSync(resolve(scenariosRoot, scenario, 'config.json'), 'utf8'),
      ) as { skill_by_hd_type: Record<string, string> };
      for (const [title, expectedSkill] of Object.entries(config.skill_by_hd_type)) {
        assert.equal(findWorkTypeByTitle(title)?.skill, expectedSkill, `${scenario}: ${title}`);
      }
    }
  });

  it('stretches a short customer window to the work norm without moving the start', () => {
    assert.deepEqual(fitWindowToService(100, 160, 80), { windowStartAt: 100, windowEndAt: 180 });
    assert.deepEqual(fitWindowToService(100, 200, 80), { windowStartAt: 100, windowEndAt: 200 });
  });
});
