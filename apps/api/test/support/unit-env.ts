import { loadJsonFixture } from './fixtures';

/**
 * Preloads inert required settings before coverage workers import Nest modules.
 * Unit coverage has no database; port 1 prevents accidental use of a local stand.
 * NODE_ENV=test also keeps ConfigModule from reading the operator's .env.
 */
const fixture = loadJsonFixture<{ dispatcherEmail: string; dispatcherPassword: string }>(
  'env-fixtures.json',
);
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://unit:unit@127.0.0.1:1/unit_coverage';
process.env.DISPATCHER_EMAIL = fixture.dispatcherEmail;
process.env.DISPATCHER_PASSWORD = fixture.dispatcherPassword;
