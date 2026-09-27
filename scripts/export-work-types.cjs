/** Export the API catalogue for the offline Python importer; run after api test:build. */
const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { WORK_TYPES } = require('../apps/api/dist-test/src/orchestrator/requests/work-type.catalog');
writeFileSync(resolve(__dirname, '../core/work-types.json'), `${JSON.stringify(WORK_TYPES, null, 2)}\n`, 'utf8');
