/**
 * P5：0010 图片上传桶 + 存储 RLS（在 db/shim/plain.sql 的 Storage 替身上）与 0011 停用分类拦截。
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  MIGRATIONS_DIR,
  SHIM,
  createDatabase,
  dbUrl,
  dropDatabase,
  migrationFiles,
  run,
  verdict,
} from './helpers';
import { T, U } from './fixtures';
import { freshDb } from './setup';

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb('p5');
});
afterAll(async () => {
  await db?.close();
});

const anon = { role: 'anon' } as const;
const as = (uid: string) => ({ role: 'authenticated', uid }) as const;
const su = { role: 'superuser' } as const;

const INSERT_OBJ = `insert into storage.objects (bucket_id, name, owner, owner_id, metadata)
  values ($1, $2, auth.uid(), auth.uid()::text, $3::jsonb)`;
const put = (
  who: ReturnType<typeof as> | typeof anon,
  name: string,
  meta: unknown = null,
  bucket = 'ugc-images',
) => run(db.pool, who, INSERT_OBJ, [bucket, name, meta === null ? null : JSON.stringify(meta)]);

describe('0010 ugc-images 桶', () => {
  it('公开读，2 MB，只收 jpeg / png / webp / gif', async () => {
    const r = await db.pool.query(
      `select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'ugc-images'`,
    );
    expect(r.rows).toEqual([
      {
        public: true,
        file_size_limit: '2097152',
        allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
      },
    ]);
  });
  it('重复执行 0010 不报错、不产生重复', async () => {
    await db.pool.query(readFileSync(join(MIGRATIONS_DIR, '0010_ugc_images.sql'), 'utf8'));
    const r = await db.pool.query(
      `select (select count(*) from storage.buckets where id = 'ugc-images') b,
              (select count(*) from pg_policies where schemaname = 'storage' and policyname like 'az_ugc_images_%') p`,
    );
    expect(r.rows[0]).toEqual({ b: '1', p: '3' });
  });
});

describe('0010 存储 RLS：上传', () => {
  it('用户可以传到自己的目录（webp / png / jpg / jpeg / gif）', async () => {
    for (const ext of ['webp', 'png', 'jpg', 'jpeg', 'gif'])
      expect(verdict(await put(as(U.alice), `${U.alice}/202610-abc123-800x600.${ext}`))).toBe('allow');
  });
  it('元数据在限制内也允许（storage-api 写入 size / mimetype 时）', async () => {
    const r = await put(as(U.alice), `${U.alice}/ok-meta.webp`, { size: 2097152, mimetype: 'image/webp' });
    expect(verdict(r)).toBe('allow');
  });
  it.each([
    ['别人的目录', () => `${U.bob}/x.webp`],
    ['根目录', () => `x.webp`],
    ['子目录', () => `${U.alice}/sub/x.webp`],
    ['路径穿越', () => `${U.alice}/../${U.bob}/x.webp`],
    ['svg', () => `${U.alice}/x.svg`],
    ['html', () => `${U.alice}/x.html`],
    ['大写 / 空格', () => `${U.alice}/My Pic.PNG`],
    ['双扩展名', () => `${U.alice}/x.webp.html`],
    ['超长文件名', () => `${U.alice}/${'a'.repeat(81)}.webp`],
  ])('拒绝：%s', async (_n, name) => {
    expect(verdict(await put(as(U.alice), name()))).toBe('deny');
  });
  it('拒绝：超过 2 MB、非图片类型（元数据存在时）', async () => {
    expect(
      verdict(await put(as(U.alice), `${U.alice}/big.webp`, { size: 2097153, mimetype: 'image/webp' })),
    ).toBe('deny');
    expect(
      verdict(await put(as(U.alice), `${U.alice}/svg.png`, { size: 10, mimetype: 'image/svg+xml' })),
    ).toBe('deny');
  });
  it('拒绝：匿名、被封禁用户、其他桶', async () => {
    expect(verdict(await put(anon, `x/x.webp`))).toBe('deny');
    expect(verdict(await put(as(U.carol), `${U.carol}/x.webp`))).toBe('deny');
    await db.pool.query(`insert into storage.buckets (id, name, public) values ('private', 'private', false)
      on conflict do nothing`);
    expect(verdict(await put(as(U.alice), `${U.alice}/x.webp`, null, 'private'))).toBe('deny');
  });
  it('封禁到期后（未解除记录）恢复上传权限', async () => {
    const c = await db.pool.connect();
    try {
      await c.query('begin');
      await c.query(
        `insert into public.user_bans (user_id, reason, expires_at) values ($1, 'x', now() - interval '1 minute')`,
        [U.carol],
      );
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: U.carol, role: 'authenticated' }),
      ]);
      await c.query('set local role authenticated');
      const r = await c.query(INSERT_OBJ, ['ugc-images', `${U.carol}/back.webp`, null]);
      expect(r.rowCount).toBe(1);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
  it('限流：10 分钟 10 张；24 小时 50 张；版主不限', async () => {
    const c = await db.pool.connect();
    const tryAs = async (uid: string, name: string) => {
      await c.query('savepoint s');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: uid, role: 'authenticated' }),
      ]);
      await c.query('set local role authenticated');
      try {
        await c.query(INSERT_OBJ, ['ugc-images', name, null]);
        await c.query('reset role');
        await c.query('release savepoint s');
        return true;
      } catch (e) {
        await c.query('rollback to savepoint s');
        expect((e as { code?: string }).code).toBe('42501');
        return false;
      }
    };
    try {
      await c.query('begin');
      for (let i = 0; i < 9; i++)
        await c.query(`insert into storage.objects (bucket_id, name) values ('ugc-images', $1)`, [
          `${U.bob}/r${i}.webp`,
        ]);
      expect(await tryAs(U.bob, `${U.bob}/tenth.webp`)).toBe(true);
      expect(await tryAs(U.bob, `${U.bob}/eleventh.webp`)).toBe(false);
      // 10 分钟前的不计入短窗口，但计入 24 小时
      await c.query(`update storage.objects set created_at = now() - interval '2 hours' where name like $1`, [
        `${U.bob}/%`,
      ]);
      expect(await tryAs(U.bob, `${U.bob}/later.webp`)).toBe(true);
      for (let i = 0; i < 40; i++)
        await c.query(
          `insert into storage.objects (bucket_id, name, created_at) values ('ugc-images', $1, now() - interval '3 hours')`,
          [`${U.bob}/d${i}.webp`],
        );
      expect(await tryAs(U.bob, `${U.bob}/over-day.webp`)).toBe(false);
      for (let i = 0; i < 12; i++)
        await c.query(`insert into storage.objects (bucket_id, name) values ('ugc-images', $1)`, [
          `${U.mia}/m${i}.webp`,
        ]);
      expect(await tryAs(U.mia, `${U.mia}/mod.webp`)).toBe(true);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});

describe('0010 存储 RLS：删除 / 修改 / 列出', () => {
  beforeAll(async () => {
    await db.pool.query(
      `insert into storage.objects (bucket_id, name) values
      ('ugc-images', $1), ('ugc-images', $2)`,
      [`${U.alice}/mine.webp`, `${U.bob}/his.webp`],
    );
  });
  const del = (who: ReturnType<typeof as>, name: string) =>
    run(db.pool, who, `delete from storage.objects where bucket_id = 'ugc-images' and name = $1`, [name]);
  it('本人可以删自己的图，不能删别人的', async () => {
    expect(verdict(await del(as(U.alice), `${U.alice}/mine.webp`))).toBe('allow');
    expect(verdict(await del(as(U.alice), `${U.bob}/his.webp`))).toBe('deny');
  });
  it('版主 / 管理员可以删任何图；被封禁的人连自己的也不能删以外的', async () => {
    expect(verdict(await del(as(U.mia), `${U.bob}/his.webp`))).toBe('allow');
    expect(verdict(await del(as(U.ada), `${U.alice}/mine.webp`))).toBe('allow');
    expect(verdict(await del(as(U.carol), `${U.bob}/his.webp`))).toBe('deny');
  });
  it('没有人能经 API 修改（覆盖）已有对象', async () => {
    for (const uid of [U.alice, U.mia, U.ada]) {
      const r = await run(
        db.pool,
        as(uid),
        `update storage.objects set name = name || 'x' where bucket_id = 'ugc-images'`,
      );
      expect(verdict(r)).toBe('deny');
    }
  });
  it('列出：本人只看到自己的；版主看到全部；匿名看不到', async () => {
    const mine = await run(
      db.pool,
      as(U.alice),
      `select name from storage.objects where bucket_id = 'ugc-images'`,
    );
    expect(mine.ok && mine.rows.map((r) => r.name)).toEqual([`${U.alice}/mine.webp`]);
    const mod = await run(
      db.pool,
      as(U.mia),
      `select name from storage.objects where bucket_id = 'ugc-images'`,
    );
    expect(mod.ok && mod.rowCount).toBe(2);
    const a = await run(db.pool, anon, `select name from storage.objects`);
    expect(a.ok && a.rowCount).toBe(0);
  });
  it('校验函数固定了 search_path，并且是 SECURITY DEFINER', async () => {
    const r = await db.pool.query(
      `select prosecdef, proconfig from pg_proc where proname = 'az_ugc_image_upload_ok'`,
    );
    expect(r.rows[0].prosecdef).toBe(true);
    expect(r.rows[0].proconfig.some((s: string) => s.startsWith('search_path='))).toBe(true);
  });
});

describe('0010 在没有 Storage 的纯 Postgres 上', () => {
  it('跳过桶与策略，其余迁移照常完成', async () => {
    const shim = readFileSync(SHIM, 'utf8');
    const cut = shim.indexOf('create schema if not exists storage');
    expect(cut).toBeGreaterThan(0);
    const dir = mkdtempSync(join(tmpdir(), 'azshim-'));
    const noStorage = join(dir, 'plain-no-storage.sql');
    writeFileSync(noStorage, shim.slice(0, cut));
    const name = `azsou_test_nostorage_${process.pid}`;
    await createDatabase(name, [noStorage, ...migrationFiles()]);
    const c = new pg.Client({ connectionString: dbUrl(name) });
    await c.connect();
    try {
      const r = await c.query(
        `select to_regnamespace('storage') is null as no_storage,
                to_regprocedure('public.az_ugc_image_upload_ok(text,jsonb)') is not null as fn,
                to_regprocedure('public.az_forum_category_disabled(text)') is not null as cat`,
      );
      expect(r.rows[0]).toEqual({ no_storage: true, fn: true, cat: true });
    } finally {
      await c.end();
      await dropDatabase(name);
    }
  });
});

describe('0011 停用分类', () => {
  const NEW = `insert into public.forum_threads (cat, title, body, author) values ($1, 'title', 'body', auth.uid())`;
  const setForum = (data: unknown, published = true) =>
    db.pool.query(
      `insert into public.site_content (kind, slug, data, published) values ('setting', 'forum', $1, $2)
       on conflict (kind, slug) do update set data = excluded.data, published = excluded.published`,
      [JSON.stringify(data), published],
    );
  const clear = () =>
    db.pool.query(`delete from public.site_content where kind = 'setting' and slug = 'forum'`);
  const techOff = {
    categories: [
      { id: 'announce', enabled: true, order: 0 },
      { id: 'product', enabled: true, order: 1 },
      { id: 'tech', enabled: false, order: 2 },
      { id: 'meta', enabled: true, order: 3 },
    ],
  };
  afterAll(clear);

  it('没有设置时与 V72 一样：任何分类都能发', async () => {
    await clear();
    for (const cat of ['技术交流', '产品讨论', '站务反馈'])
      expect(verdict(await run(db.pool, as(U.alice), NEW, [cat]))).toBe('allow');
  });
  it('停用「技术交流」后：用户发帖被拒（中文错误），其他分类正常', async () => {
    await setForum(techOff);
    const r = await run(db.pool, as(U.alice), NEW, ['技术交流']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('42501');
      expect(r.message).toContain('分类已停用');
    }
    expect(verdict(await run(db.pool, as(U.alice), NEW, ['tech']))).toBe('deny');
    expect(verdict(await run(db.pool, as(U.alice), NEW, ['产品讨论']))).toBe('allow');
  });
  it('不能把主题移入停用分类；已在停用分类里的主题可以编辑', async () => {
    await setForum(techOff);
    const move = await run(
      db.pool,
      as(U.alice),
      `update public.forum_threads set cat = '技术交流' where id = $1`,
      [T.alice],
    );
    expect(verdict(move)).toBe('deny');
    const c = await db.pool.connect();
    try {
      await c.query('begin');
      await c.query(`update public.forum_threads set cat = '技术交流' where id = $1`, [T.alice]);
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: U.alice, role: 'authenticated' }),
      ]);
      await c.query('set local role authenticated');
      const r = await c.query(`update public.forum_threads set title = 'edited' where id = $1`, [T.alice]);
      expect(r.rowCount).toBe(1);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
  it('版主 / 管理员不受限；超级用户（迁移 / 导入）不受限；被封禁的人本来就不能发', async () => {
    await setForum(techOff);
    expect(verdict(await run(db.pool, as(U.mia), NEW, ['技术交流']))).toBe('allow');
    expect(verdict(await run(db.pool, as(U.ada), NEW, ['技术交流']))).toBe('allow');
    expect(
      verdict(
        await run(
          db.pool,
          su,
          `insert into public.forum_threads (cat, title, body, author) values ('技术交流', 't', 'b', $1)`,
          [U.alice],
        ),
      ),
    ).toBe('allow');
    expect(verdict(await run(db.pool, as(U.carol), NEW, ['产品讨论']))).toBe('deny');
  });
  it('设置未发布 / 格式不对 / enabled 不是布尔 → 放行', async () => {
    await setForum(techOff, false);
    expect(verdict(await run(db.pool, as(U.alice), NEW, ['技术交流']))).toBe('allow');
    for (const bad of [{ categories: 'nope' }, {}, { categories: [{ id: 'tech', enabled: 'false' }] }]) {
      await setForum(bad);
      expect(verdict(await run(db.pool, as(U.alice), NEW, ['技术交流']))).toBe('allow');
    }
  });
  it('被拦下的请求不计入发帖限流', async () => {
    await setForum(techOff);
    const c = await db.pool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: U.bob, role: 'authenticated' }),
      ]);
      await c.query('set local role authenticated');
      for (let i = 0; i < 5; i++) {
        await c.query('savepoint s');
        await expect(c.query(NEW, ['技术交流'])).rejects.toThrow(/分类已停用/);
        await c.query('rollback to savepoint s');
      }
      await c.query('reset role');
      const n = await c.query(
        `select count(*)::int n from public.rate_limit_events where user_id = $1 and action = 'thread'`,
        [U.bob],
      );
      expect(n.rows[0].n).toBe(0);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});
