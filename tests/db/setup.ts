/** 每个测试文件一个独立的临时库：shim + 全部迁移 + 夹具 */
import pg from 'pg';
import { SHIM, createDatabase, dbUrl, dropDatabase, migrationFiles } from './helpers';
import { seed } from './fixtures';

export async function freshDb(tag: string, opts: { files?: string[]; seed?: boolean } = {}) {
  const name = `azsou_test_${tag}_${process.pid}`;
  await createDatabase(name, opts.files ?? [SHIM, ...migrationFiles()]);
  if (opts.seed !== false) {
    const c = new pg.Client({ connectionString: dbUrl(name) });
    await c.connect();
    try {
      await seed(c);
    } finally {
      await c.end();
    }
  }
  const pool = new pg.Pool({ connectionString: dbUrl(name), max: 4 });
  return {
    name,
    pool,
    async close() {
      await pool.end();
      await dropDatabase(name);
    },
  };
}
