import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { defaultCorpusRoot, indexKnowledge } from '../src/ai/knowledge/knowledge.indexer';
import { PrismaClient } from '../src/generated/prisma/client';

/**
 * Rebuilds `ai_documents` from `docs/knowledge/**` outside the running application.
 *
 * `pnpm --filter api knowledge:index` (docs/knowledge/README.md, "Переиндексация").
 * `KnowledgeIndexerService` already runs this same pass at application boot; this script
 * exists so a corpus edit can be picked up without restarting the whole process, and so
 * CI or a developer can rebuild the index as a standalone step. It talks to PostgreSQL
 * directly with the same driver adapter the application uses -- unlike
 * `scripts/smoke.ts`, there is no HTTP endpoint to call for this, only a table to write.
 */

function findWorkspaceRoot(startDir: string): string {
  let dir = startDir;
  while (!existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error('Cannot locate the LCT workspace root (no pnpm-workspace.yaml above here)');
    }
    dir = parent;
  }
  return dir;
}

function loadRootEnv(root: string): void {
  if (process.env.DATABASE_URL) return;
  const envPath = resolve(root, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    const key = match?.[1];
    if (key && !process.env[key]) {
      process.env[key] = match?.[2]?.trim() ?? '';
    }
  }
}

async function main(): Promise<void> {
  const workspaceRoot = findWorkspaceRoot(__dirname);
  loadRootEnv(workspaceRoot);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Run `cp .env.example .env` and `pnpm compose:up` first.',
    );
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    await prisma.$connect();
    const summary = await indexKnowledge(prisma, defaultCorpusRoot());
    console.log(
      `Indexed ${summary.filesRead} articles, ${summary.sectionsSeen} sections: ` +
        `${summary.sectionsWritten} written, ${summary.sectionsUnchanged} unchanged, ` +
        `${summary.sectionsDeleted} deleted.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
