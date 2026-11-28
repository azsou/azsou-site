import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { U } from './fixtures';
import { ADMIN_URL, dbUrl, migrationFiles, ROOT, run, SHIM, type Who } from './helpers';
import { freshDb } from './setup';

// This suite checks the Storage RLS metadata layer, not a hosted role or an authenticated image download.
const bucket = 'az-cms-draft-media-sb05';
const other = 'sb05-other-private-ci';
const png = 'sb05-check-864e09ae.png';
const policy = 'az_sb05_canary_preview_read';
const pilot = join(ROOT, 'db/pilots/official-media-preview.sql');
const station: Who = { role: 'authenticated', uid: U.ada };
const denied: [string, Who][] = [
  ['guest', { role: 'anon' }],
  ['user', { role: 'authenticated', uid: U.alice }],
  ['moderator', { role: 'authenticated', uid: U.mia }],
  ['restricted user', { role: 'authenticated', uid: U.carol }],
];
const policySql = `select policyname, cmd, permissive, array_to_string(roles, ',') as roles,
  qual, with_check from pg_policies where schemaname='storage' and tablename='objects' order by policyname`;

describe.skipIf(!process.env.CI)('SB05 dedicated private PNG in a disposable CI database', () => {
  let db: Awaited<ReturnType<typeof freshDb>> | undefined;
  let baseline: Record<string, unknown>[];
  beforeAll(async () => {
    const u = new URL(ADMIN_URL);
    if (process.env.GITHUB_ACTIONS !== 'true' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
      throw new Error('SB05 requires the loopback GitHub Actions fixture');
    }
    const expected = `azsou_test_cmsmedia_${process.pid}`;
    const control = new pg.Client({ connectionString: dbUrl('postgres') });
    await control.connect();
    try {
      const found = await control.query('select 1 from pg_database where datname = $1', [expected]);
      if (found.rows.length) throw new Error('SB05 refuses to reuse an existing database');
    } finally {
      await control.end();
    }
    db = await freshDb('cmsmedia', { files: [SHIM, ...migrationFiles()] });
    if (db.name !== expected) throw new Error('Unexpected SB05 fixture database');
    const actual = await db.pool.query('select current_database() as name');
    if (actual.rows[0]?.name !== expected) throw new Error('Misrouted SB05 fixture');
    await db.pool.query(
      `insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
       values ($1,$1,false,1048576,array['image/png']),($2,$2,false,1048576,array['image/png'])`,
      [bucket, other],
    );
    await db.pool.query('insert into storage.objects (bucket_id, name) values ($1,$2),($1,$3),($4,$2)', [
      bucket,
      png,
      'sb05-sibling.png',
      other,
    ]);
    baseline = (await db.pool.query(policySql)).rows;
    if (baseline.some((r) => r.policyname === policy))
      throw new Error('Unexpected pre-existing pilot policy');
    if (existsSync(pilot)) await db.pool.query(readFileSync(pilot, 'utf8'));
  });
  afterAll(async () => {
    await db?.close();
  });

  async function visible(who: Who) {
    const r = await run(
      db!.pool,
      who,
      'select bucket_id, name from storage.objects where bucket_id in ($1,$2) order by bucket_id, name',
      [bucket, other],
    );
    if (!r.ok) throw new Error(`SB05 metadata read unexpectedly failed (${r.code})`);
    return r.rows;
  }
  it('station administrator can read precisely the one intended record, not its sibling or other bucket', async () => {
    expect(await visible(station)).toEqual([{ bucket_id: bucket, name: png }]);
  });
  for (const [label, who] of denied) {
    it(`${label} does not see any of the three private fixture records`, async () => {
      expect(await visible(who)).toEqual([]);
    });
  }
  it('retains every pre-existing object policy and adds only authenticated SELECT', async () => {
    const now = (await db!.pool.query(policySql)).rows;
    expect(now.filter((r) => r.policyname !== policy)).toEqual(baseline);
    expect(now.filter((r) => r.policyname === policy)).toEqual([
      expect.objectContaining({ cmd: 'SELECT', roles: 'authenticated', with_check: null }),
    ]);
    const b = await db!.pool.query('select public from storage.buckets where id in ($1,$2)', [bucket, other]);
    expect(b.rows).toEqual([{ public: false }, { public: false }]);
  });
});
