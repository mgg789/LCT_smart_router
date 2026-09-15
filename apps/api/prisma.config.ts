import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration.
 *
 * Prisma 7 takes the connection URL out of the schema: migrations read it from here and
 * the runtime gets it from a driver adapter instead. Keeping the two apart is useful
 * rather than merely mandatory -- schema changes and ordinary business writes are meant
 * to run under different database roles (context/43 section 5.1).
 */

/**
 * `MIGRATE_DATABASE_URL` is where a deployment points the migration owner; it falls back
 * to `DATABASE_URL` so a developer machine needs one variable instead of two.
 *
 * The placeholder exists because `prisma generate` loads this file but never connects,
 * and code generation has to work during an image build where no database is reachable.
 * Any command that does connect fails immediately, naming the unset variable.
 */
function migrationDatabaseUrl(): string {
  return (
    process.env.MIGRATE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://unset@database-url-is-not-set:5432/unset'
  );
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: migrationDatabaseUrl(),
  },
});
