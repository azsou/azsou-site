/**
 * db/verify/status.sql（生产切换时每一步之后执行的核对 SQL）：迁移完全部为 true；只有 baseline（生产现状）时 0002+ 全为 false；
 * 逐步执行时，第 N 步及之前为 true、之后为 false。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { ROOT, SHIM, createDatabase, dbUrl, dropDatabase, migrationFiles } from './helpers';

const STATUS = readFileSync(join(ROOT, 'db/verify/status.sql'), 'utf8');
const name = `azsou_test_verify_${process.pid}`;
afterAll(() => dropDatabase(name));

describe('db/verify/status.sql', () => {
  it('逐个迁移执行：每一步之后，该步及之前全部通过、之后全部未通过', async () => {
    const files = migrationFiles();
    await createDatabase(name, [SHIM, files[0]]);
    const c = new pg.Client({ connectionString: dbUrl(name) });
    await c.connect();
    try {
      await c.query('set client_min_messages = warning');
      const check = async (done: string) => {
        const r = await c.query(STATUS);
        for (const row of r.rows)
          expect(row.ok, `${done} 之后：${row.step} ${row.item}`).toBe(row.step <= done);
        return r.rowCount;
      };
      expect(await check('0001')).toBeGreaterThanOrEqual(15);
      for (const f of files.slice(1)) {
        await c.query(readFileSync(f, 'utf8'));
        await check(f.split('/').pop()!.slice(0, 4));
      }
    } finally {
      await c.end();
    }
  });
});
