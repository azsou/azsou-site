/** 每个测试文件一个独立的临时库：shim + 全部迁移 + 夹具 */
import pg from 'pg';
import { SHIM, createDatabase, dbUrl, dropDatabase, migrationFiles } from './helpers';
import { seed } from './fixtures';

/**
 * DB_TEST_TEMPLATE=<库名>：默认（shim + 全部迁移）的库改为从这个模板复制——恢复演练用它在
 * 「从备份恢复出来的库」上跑同一套 RLS / 后台测试（scripts/restore-drill.sh）。
 */
async function fromTemplate(name: string, template: string) {
  const admin = new pg.Client({ connectionString: dbUrl('postgres') });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.query(`create database ${name} template ${template}`);
  } finally {
    await admin.end();
  }
}

export async function freshDb(tag: string, opts: { files?: string[]; seed?: boolean } = {}) {
  const name = `azsou_test_${tag}_${process.pid}`;
  const template = process.env.DB_TEST_TEMPLATE;
  if (template && !opts.files) await fromTemplate(name, template);
  else await createDatabase(name, opts.files ?? [SHIM, ...migrationFiles()]);
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
