import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminApiFor } from '@/lib/data/admin-repo';
import { memoryStore } from '@/lib/data/session';
import { createSupabaseRepository } from '@/lib/data/supabase';
import { ForbiddenError, NotSignedInError } from '@/lib/data/types';
import { U } from './fixtures';
import { ADMIN_URL, ROOT, run, type Outcome, type Who } from './helpers';
import { ANON, BIN, freePort, startPostgrest, tok } from './postgrest';
import { freshDb } from './setup';

const admin: Who = { role: 'authenticated', uid: U.ada };
const pilot = join(ROOT, 'db/pilots/article-drafts.sql');
let db: Awaited<ReturnType<typeof freshDb>>;

beforeAll(async () => {
  const host = new URL(ADMIN_URL).hostname;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) throw new Error('Local CI PostgreSQL only');
  db = await freshDb('cmsarticle');
  if (!/^azsou_test_cmsarticle_[0-9]+$/.test(db.name)) throw new Error('Unexpected pilot database');
  // Test-first: on the baseline run all assertions against the unchanged database, with NO fallback or mock.
  // Once the candidate exists, apply its exact SQL only to this test file's disposable database.
  if (existsSync(pilot)) await db.pool.query(readFileSync(pilot, 'utf8'));
});

afterAll(async () => {
  if (db) await db.close();
});

function ok(o: Outcome) {
  if (!o.ok) throw new Error(`Unexpected database error ${o.code}: ${o.message}`);
  return o.rows;
}

function fields(title: string) {
  return { title, toc: ['Test section'], extra: { synthetic: true } };
}

function save(slug: string, base: number, title: string, body: string, who: Who = admin) {
  const sql = 'select * from public.az_cms_save_article_draft($1, $2, $3::jsonb, $4)';
  return run(db.pool, who, sql, [slug, base, JSON.stringify(fields(title)), body], { commit: true });
}

function read(slug: string, who: Who = admin) {
  return run(db.pool, who, 'select * from public.az_cms_read_article_draft($1)', [slug]);
}

describe('official article draft storage in a disposable database', () => {
  it('persists a private first revision and its metadata across transactions', async () => {
    const slug = 'ci-draft-roundtrip';
    const created = ok(await save(slug, 0, 'Sample one', 'Test body'));
    expect(created).toEqual([{ item_id: expect.any(String), revision: 1 }]);
    const expected = { ...created[0], fields: fields('Sample one'), body_source: 'Test body' };
    expect(ok(await read(slug))).toEqual([expected]);
    const receipt = await db.pool.query(
      `select a.published_revision, r.saved_by from private.cms_article_items a
       join private.cms_article_revisions r on r.item_id = a.id and r.revision = a.draft_revision
       where a.slug = $1`,
      [slug],
    );
    expect(receipt.rows).toEqual([{ published_revision: null, saved_by: U.ada }]);
  });

  it('editing a published item leaves its published pointer and old bytes unchanged', async () => {
    const slug = 'ci-draft-live-pointer';
    const [first] = ok(await save(slug, 0, 'Old title', 'Old body'));
    // Seed an already-published revision in the test fixture. This is NOT an application publish API.
    const seedPointer = 'update private.cms_article_items set published_revision = 1 where id = $1';
    await db.pool.query(seedPointer, [first.item_id]);
    const [next] = ok(await save(slug, 1, 'New title', 'Private body'));
    expect(next).toEqual({ item_id: first.item_id, revision: 2 });
    expect(ok(await read(slug))[0]).toMatchObject({ revision: 2, body_source: 'Private body' });
    const live = await db.pool.query(
      `select a.published_revision as revision, r.fields, r.body_source from private.cms_article_items a
       join private.cms_article_revisions r on r.item_id = a.id and r.revision = a.published_revision
       where a.slug = $1`,
      [slug],
    );
    expect(live.rows).toEqual([{ revision: 1, fields: fields('Old title'), body_source: 'Old body' }]);
  });

  it('allows only one of two saves based on the same revision', async () => {
    const slug = 'ci-draft-conflict';
    const [first] = ok(await save(slug, 0, 'Base', 'base'));
    const left = save(slug, 1, 'Left', 'left');
    const right = save(slug, 1, 'Right', 'right');
    const results = await Promise.all([left, right]);
    expect(results.filter((o) => o.ok)).toHaveLength(1);
    expect(results.filter((o) => !o.ok)).toMatchObject([{ code: 'PT409' }]);
    const winningBody = results[0].ok ? 'left' : 'right';
    expect(ok(await read(slug))[0]).toMatchObject({ revision: 2, body_source: winningBody });
    const history = await db.pool.query(
      'select revision from private.cms_article_revisions where item_id = $1 order by revision',
      [first.item_id],
    );
    expect(history.rows).toEqual([{ revision: 1 }, { revision: 2 }]);
  });

  it('restricts draft reads and writes to the station administrator', async () => {
    const slug = 'ci-draft-private';
    ok(await save(slug, 0, 'Private', 'private'));
    const others: Who[] = [
      { role: 'anon' },
      { role: 'authenticated', uid: U.alice },
      { role: 'authenticated', uid: U.mia },
      { role: 'authenticated', uid: U.carol },
    ];
    for (const who of others) {
      expect(await read(slug, who)).toMatchObject({ ok: false, code: '42501' });
      expect(await save(slug, 1, 'Changed', 'changed', who)).toMatchObject({ ok: false, code: '42501' });
    }
    expect(ok(await read(slug))[0]).toMatchObject({ revision: 1, body_source: 'private' });
    const grants = await db.pool.query(
      `select has_table_privilege('anon', 'private.cms_article_revisions', 'select') as anon_read,
              has_table_privilege('authenticated', 'private.cms_article_items', 'update') as raw_edit`,
    );
    expect(grants.rows).toEqual([{ anon_read: false, raw_edit: false }]);
  });

  it('rejects an empty title and a nonzero first base without leaving a phantom item', async () => {
    const slug = 'ci-draft-validation';
    expect(await save(slug, 0, ' ', 'body')).toMatchObject({ ok: false, code: '22023' });
    expect(await save(slug, 3, 'Missing base', 'body')).toMatchObject({ ok: false, code: 'PT409' });
    expect(ok(await read(slug))).toEqual([]);
    const items = await db.pool.query('select id from private.cms_article_items where slug = $1', [slug]);
    expect(items.rows).toEqual([]);
  });
});

// SB04: use the same file's guarded disposable database and its installed pilot SQL.
// Session identities are generated by the existing local test fixture, not by hosted Auth.
type HttpFields = Record<string, unknown> & { title: string };
type HttpInput = { slug: string; expectedRevision: number; fields: HttpFields; bodySource: string };
type HttpReceipt = { itemId: string; revision: number };
interface DraftPortContract {
  read(slug: string): Promise<(HttpReceipt & { fields: HttpFields; bodySource: string }) | null>;
  save(input: HttpInput): Promise<HttpReceipt>;
}

describe.skipIf(!BIN && !process.env.CI)('official article draft workbench over local PostgREST', () => {
  let server: ChildProcess | undefined;
  let origin: string;

  beforeAll(async () => {
    if (!BIN) throw new Error('SB04: CI must provide PostgREST for the article draft HTTP contract');
    const port = await freePort();
    server = await startPostgrest(db.name, port);
    origin = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server?.kill();
  });

  function client(uid: string | null, syntheticReply?: () => Response) {
    const trace: { path: string; status: number }[] = [];
    const store = memoryStore(
      uid
        ? {
            accessToken: tok(uid),
            refreshToken: 'local-fixture-only',
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            user: { id: uid, email: null, emailConfirmed: true, provider: 'email' },
          }
        : null,
    );
    const repo = createSupabaseRepository({
      url: origin,
      key: ANON,
      store,
      fetch: async (input, init) => {
        const target = new URL(input instanceof Request ? input.url : String(input));
        if (target.origin !== origin || !target.pathname.startsWith('/rest/v1/rpc/')) {
          throw new Error('SB04: loopback draft RPC transport only');
        }
        // The standalone test binary has no Supabase gateway prefix.
        target.pathname = target.pathname.slice('/rest/v1'.length);
        const localFetch = () => fetch(target, { ...init, redirect: 'error' });
        const response = syntheticReply ? syntheticReply() : await localFetch();
        trace.push({ path: target.pathname, status: response.status });
        return response;
      },
    });
    const workbench = adminApiFor(repo);
    if (!workbench) throw new Error('SB04: expected the existing Supabase admin workbench');
    // Test the existing entry point, not a missing import. The baseline should fail this assertion.
    expect(workbench, 'SB04: admin workbench must expose articleDrafts').toHaveProperty('articleDrafts');
    const drafts = Reflect.get(workbench, 'articleDrafts') as DraftPortContract;
    return { drafts, trace };
  }

  const draftInput = (slug: string): HttpInput => ({
    slug,
    expectedRevision: 0,
    fields: { title: 'CI article', toc: ['First'], optional: { labels: ['保留', 'test'] } },
    bodySource: '  <p>合成稿</p>\n',
  });

  it('reads a missing slug as null and round-trips the full draft through a fresh client', async () => {
    const a = client(U.ada);
    const draft = draftInput('ci-http-article-roundtrip');
    expect(await a.drafts.read(draft.slug)).toBeNull();
    const saved = await a.drafts.save(draft);
    expect(saved).toEqual({ itemId: expect.any(String), revision: 1 });
    const reopened = await client(U.ada).drafts.read(draft.slug);
    expect(reopened).toEqual({ ...saved, fields: draft.fields, bodySource: draft.bodySource });
    const paths = ['/rpc/az_cms_read_article_draft', '/rpc/az_cms_save_article_draft'];
    expect(a.trace.map((r) => r.path)).toEqual(paths);
  });

  it('rejects a stale save once with HTTP 409 and leaves the newer draft intact', async () => {
    const a = client(U.ada);
    const b = client(U.ada);
    const draft = draftInput('ci-http-article-conflict');
    const first = await a.drafts.save(draft);
    const loaded = await b.drafts.read(draft.slug);
    expect(loaded?.revision).toBe(first.revision);
    const current = { ...draft, expectedRevision: first.revision, bodySource: 'Newer body' };
    const next = await a.drafts.save(current);
    expect(next).toEqual({ itemId: first.itemId, revision: 2 });
    const from = b.trace.length;
    const stale = { ...draft, expectedRevision: first.revision, bodySource: 'Stale body' };
    await expect(b.drafts.save(stale)).rejects.toThrow(/article draft version conflict/);
    expect(b.trace.slice(from)).toEqual([{ path: '/rpc/az_cms_save_article_draft', status: 409 }]);
    const winner = { ...next, fields: draft.fields, bodySource: 'Newer body' };
    expect(await b.drafts.read(draft.slug)).toEqual(winner);
  });

  it('requires a session and lets the database reject ordinary users and moderators', async () => {
    const draft = draftInput('ci-http-article-private');
    const station = client(U.ada);
    const saved = await station.drafts.save(draft);
    const change = { ...draft, expectedRevision: saved.revision, bodySource: 'Unaccepted edit' };
    const guest = client(null);
    await expect(guest.drafts.read(draft.slug)).rejects.toBeInstanceOf(NotSignedInError);
    await expect(guest.drafts.save(change)).rejects.toBeInstanceOf(NotSignedInError);
    expect(guest.trace).toEqual([]);
    for (const uid of [U.alice, U.mia]) {
      const other = client(uid);
      await expect(other.drafts.read(draft.slug)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(other.drafts.save(change)).rejects.toBeInstanceOf(ForbiddenError);
      expect(other.trace.map((r) => r.status)).toEqual([403, 403]);
    }
    const original = { ...saved, fields: draft.fields, bodySource: draft.bodySource };
    expect(await station.drafts.read(draft.slug)).toEqual(original);
  });

  it('does not treat a missing endpoint as a missing draft or try a fallback write', async () => {
    const missing = () => Response.json({ code: 'PGRST202', message: 'Test RPC missing' }, { status: 404 });
    const a = client(U.ada, missing);
    const draft = draftInput('ci-http-article-schema');
    const schema = { name: 'SchemaMissingError', kind: 'schema' };
    const readError = { ...schema, object: 'az_cms_read_article_draft' };
    const saveError = { ...schema, object: 'az_cms_save_article_draft' };
    await expect(a.drafts.read(draft.slug)).rejects.toMatchObject(readError);
    await expect(a.drafts.save(draft)).rejects.toMatchObject(saveError);
    expect(a.trace.map((r) => r.status)).toEqual([404, 404]);
  });

  it('rejects malformed success replies instead of returning an empty draft or a fake receipt', async () => {
    const draft = draftInput('ci-http-article-response');
    const row = { item_id: U.ada, revision: 1, fields: draft.fields, body_source: draft.bodySource };
    for (const reply of [null, [row, row], [{ ...row, body_source: 3 }]]) {
      const a = client(U.ada, () => Response.json(reply));
      await expect(a.drafts.read(draft.slug)).rejects.toMatchObject({ kind: 'bad-response' });
      expect(a.trace).toHaveLength(1);
    }
    for (const reply of [[], [{ ...row, item_id: '' }], [{ ...row, revision: 3 }]]) {
      const a = client(U.ada, () => Response.json(reply));
      await expect(a.drafts.save(draft)).rejects.toMatchObject({ kind: 'bad-response' });
      expect(a.trace).toHaveLength(1);
    }
  });
});

// SB09 contract only. Uses the original file's CI database and the normal draft RPC; no hosted API or public page.
describe.skipIf(process.env.CI !== 'true')(
  'SB09 article release lifecycle in the disposable article DB',
  () => {
    type Act = 'submit_review' | 'publish' | 'withdraw' | 'restore_review';
    const releasePilot = join(ROOT, 'db/pilots/article-release.sql');
    const op = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

    beforeAll(async () => {
      const expected = `azsou_test_cmsarticle_${process.pid}`;
      const host = new URL(ADMIN_URL).hostname;
      if (
        process.env.GITHUB_ACTIONS !== 'true' ||
        !['localhost', '127.0.0.1', '[::1]'].includes(host) ||
        db.name !== expected
      )
        throw new Error('SB09 requires the existing disposable GitHub Actions article database');
      const id = await db.pool.query('select current_database() as name');
      if (id.rows[0]?.name !== expected) throw new Error('Unexpected SB09 database');
      // Without the new file, exercise the absent interface: never skip or substitute a fake implementation.
      if (existsSync(releasePilot)) await db.pool.query(readFileSync(releasePilot, 'utf8'));
    });

    function ciBody(n: number) {
      return `<p>SB09 synthetic revision ${n}.</p>`;
    }

    async function putDraft(slug: string, base: number, issue?: 'no-author' | 'disclosure') {
      const meta: Record<string, unknown> = {
        title: `CI article ${base + 1}`,
        category: 'CI',
        badge: 'CI',
        author: 'Fixture',
        date: '2026-01-01',
        lastChecked: '2026-01-01',
        ogImage: '/og/ci-sb09.png',
        pinyin: '',
        art: null,
        forumThread: null,
        readingMinutes: 1,
        order: 1,
        tags: ['ci'],
        toc: [],
      };
      if (issue === 'no-author') delete meta.author;
      if (issue === 'disclosure') meta.disclosure = { type: 'sponsored', sponsor: 'Test sponsor' };
      const rows = ok(
        await run(
          db.pool,
          admin,
          'select * from public.az_cms_save_article_draft($1,$2,$3::jsonb,$4)',
          [slug, base, JSON.stringify(meta), ciBody(base + 1)],
          { commit: true },
        ),
      );
      expect(rows).toEqual([{ item_id: expect.any(String), revision: base + 1 }]);
      return rows[0].item_id;
    }

    function change(
      slug: string,
      act: Act,
      draft: number,
      generation: number,
      key: number,
      who: Who = admin,
    ) {
      return run(
        db.pool,
        who,
        'select * from public.az_cms_transition_article_release($1,$2,$3,$4,$5::uuid)',
        [slug, act, draft, generation, op(key)],
        { commit: true },
      );
    }

    async function checkPointer(slug: string, draft: number, live: number | null) {
      // Independent persisted state, not a public HTTP test or a reachability assertion.
      const r = await db.pool.query(
        `select a.draft_revision, a.published_revision, r.body_source
      from private.cms_article_items a left join private.cms_article_revisions r
      on r.item_id=a.id and r.revision=a.published_revision where a.slug=$1`,
        [slug],
      );
      expect(r.rows).toEqual([
        { draft_revision: draft, published_revision: live, body_source: live === null ? null : ciBody(live) },
      ]);
    }

    async function audit(slug: string) {
      const r = await db.pool.query<{
        action: string;
        actor_id: string;
        release_version: number;
        operation_id: string;
      }>(
        `select e.action,e.actor_id,e.release_version,e.operation_id from private.cms_article_release_events e
       join private.cms_article_items a on a.id=e.item_id where a.slug=$1 order by e.release_version`,
        [slug],
      );
      return r.rows;
    }

    async function seedLive(slug: string, key: number) {
      const id = await putDraft(slug, 0);
      expect(ok(await change(slug, 'submit_review', 1, 0, key))).toEqual([
        { item_id: id, release_version: 1, phase: 'review', published_revision: null },
      ]);
      const result = ok(await change(slug, 'publish', 1, 1, key + 1));
      expect(result).toEqual([
        { item_id: id, release_version: 2, phase: 'published', published_revision: 1 },
      ]);
      return result;
    }

    it('keeps saving and review private, and keeps the old published bytes while a new revision is under review', async () => {
      const s = 'ci-release-review';
      const id = await putDraft(s, 0);
      await checkPointer(s, 1, null);
      ok(await change(s, 'submit_review', 1, 0, 11));
      await checkPointer(s, 1, null);
      ok(await change(s, 'publish', 1, 1, 12));
      expect(await putDraft(s, 1)).toBe(id);
      await checkPointer(s, 2, 1);
      ok(await change(s, 'submit_review', 2, 2, 13));
      await checkPointer(s, 2, 1);
      ok(await change(s, 'publish', 2, 3, 14));
      await checkPointer(s, 2, 2);
      const events = await audit(s);
      expect(events.map((e) => [e.action, e.release_version, e.actor_id, e.operation_id])).toEqual([
        ['submit_review', 1, U.ada, op(11)],
        ['publish', 2, U.ada, op(12)],
        ['submit_review', 3, U.ada, op(13)],
        ['publish', 4, U.ada, op(14)],
      ]);
    });

    it('withdraws the public pointer and restores to review, never directly to published', async () => {
      const s = 'ci-release-restore';
      await seedLive(s, 21);
      await putDraft(s, 1);
      expect(ok(await change(s, 'withdraw', 2, 2, 23))[0]).toMatchObject({
        phase: 'withdrawn',
        release_version: 3,
        published_revision: null,
      });
      await checkPointer(s, 2, null);
      expect(await change(s, 'publish', 2, 3, 24)).toMatchObject({ ok: false, code: 'PT409' });
      expect(ok(await change(s, 'restore_review', 2, 3, 25))[0]).toMatchObject({
        phase: 'review',
        release_version: 4,
        published_revision: null,
      });
      await checkPointer(s, 2, null);
      ok(await change(s, 'publish', 2, 4, 26));
      await checkPointer(s, 2, 2);
      expect((await audit(s)).map((e) => e.action)).toEqual([
        'submit_review',
        'publish',
        'withdraw',
        'restore_review',
        'publish',
      ]);
    });

    it('replays the original receipt after withdrawal without republishing and rejects a reused key with different input', async () => {
      const s = 'ci-release-replay';
      const id = await putDraft(s, 0);
      ok(await change(s, 'submit_review', 1, 0, 31));
      const sameKey = await Promise.all([change(s, 'publish', 1, 1, 32), change(s, 'publish', 1, 1, 32)]);
      const receipt = ok(sameKey[0]);
      expect(ok(sameKey[1])).toEqual(receipt);
      expect(receipt).toEqual([
        { item_id: id, release_version: 2, phase: 'published', published_revision: 1 },
      ]);
      expect((await audit(s)).map((e) => e.operation_id)).toEqual([op(31), op(32)]);
      ok(await change(s, 'withdraw', 1, 2, 33));
      expect(ok(await change(s, 'publish', 1, 1, 32))).toEqual(receipt);
      expect(await change(s, 'restore_review', 1, 3, 32)).toMatchObject({ ok: false, code: 'PT409' });
      await checkPointer(s, 1, null);
      expect((await audit(s)).map((e) => e.operation_id)).toEqual([op(31), op(32), op(33)]);
    });

    it('admits only one of two concurrent publishes of the same reviewed version', async () => {
      const s = 'ci-release-race';
      await putDraft(s, 0);
      ok(await change(s, 'submit_review', 1, 0, 41));
      const pair = await Promise.all([change(s, 'publish', 1, 1, 42), change(s, 'publish', 1, 1, 43)]);
      expect(pair.filter((x) => x.ok)).toHaveLength(1);
      expect(pair.filter((x) => !x.ok)).toMatchObject([{ code: 'PT409' }]);
      await checkPointer(s, 1, 1);
      const events = await audit(s);
      expect(events.map((e) => [e.action, e.release_version])).toEqual([
        ['submit_review', 1],
        ['publish', 2],
      ]);
      expect(events[1].operation_id).toBe(pair[0].ok ? op(42) : op(43));
    });

    it('rejects a stale draft, a changed draft without a fresh review, and a stale release generation', async () => {
      const s = 'ci-release-stale';
      await putDraft(s, 0);
      ok(await change(s, 'submit_review', 1, 0, 51));
      await putDraft(s, 1);
      expect(await change(s, 'publish', 1, 1, 52)).toMatchObject({ ok: false, code: 'PT409' });
      expect(await change(s, 'publish', 2, 1, 53)).toMatchObject({ ok: false, code: 'PT409' });
      await checkPointer(s, 2, null);
      ok(await change(s, 'submit_review', 2, 1, 54));
      expect(await change(s, 'publish', 2, 1, 55)).toMatchObject({ ok: false, code: 'PT409' });
      expect((await audit(s)).map((e) => e.operation_id)).toEqual([op(51), op(54)]);
      ok(await change(s, 'publish', 2, 2, 56));
      await checkPointer(s, 2, 2);
    });

    it('rejects publication of an incomplete reviewed revision without changing the previous public bytes or audit', async () => {
      const s = 'ci-release-validation';
      await seedLive(s, 61);
      await putDraft(s, 1, 'no-author');
      ok(await change(s, 'submit_review', 2, 2, 63));
      expect(await change(s, 'publish', 2, 3, 64)).toMatchObject({ ok: false, code: '22023' });
      await checkPointer(s, 2, 1);
      expect(ok(await read(s))[0]).toMatchObject({ revision: 2, body_source: ciBody(2) });
      expect((await audit(s)).map((e) => e.operation_id)).toEqual([op(61), op(62), op(63)]);
      await putDraft(s, 2, 'disclosure');
      ok(await change(s, 'submit_review', 3, 3, 65));
      expect(await change(s, 'publish', 3, 4, 66)).toMatchObject({ ok: false, code: '22023' });
      await checkPointer(s, 3, 1);
      expect(ok(await read(s))[0]).toMatchObject({
        revision: 3,
        fields: { disclosure: { type: 'sponsored', sponsor: 'Test sponsor' } },
      });
      expect((await audit(s)).map((e) => e.operation_id)).toEqual([op(61), op(62), op(63), op(65)]);
    });

    it('keeps four non-station identities from publishing or replaying a station receipt', async () => {
      const s = 'ci-release-roles';
      await putDraft(s, 0);
      ok(await change(s, 'submit_review', 1, 0, 71));
      const others: Who[] = [
        { role: 'anon' },
        { role: 'authenticated', uid: U.alice },
        { role: 'authenticated', uid: U.mia },
        { role: 'authenticated', uid: U.carol },
      ];
      for (const [i, who] of others.entries()) {
        expect(await change(s, 'publish', 1, 1, 72 + i, who)).toMatchObject({ ok: false, code: '42501' });
        expect(await change(s, 'submit_review', 1, 0, 71, who)).toMatchObject({ ok: false, code: '42501' });
      }
      await checkPointer(s, 1, null);
      expect((await audit(s)).map((e) => e.operation_id)).toEqual([op(71)]);
      const acl = await db.pool
        .query(`select has_table_privilege('anon','private.cms_article_release_events','select') as guest_audit,
      has_table_privilege('authenticated','private.cms_article_release_events','insert') as raw_append`);
      expect(acl.rows).toEqual([{ guest_audit: false, raw_append: false }]);
    });

    it('does not manufacture an unknown item or use publish as a shortcut around review', async () => {
      const s = 'ci-release-no-shortcut';
      expect(await change(s, 'submit_review', 1, 0, 81)).toMatchObject({ ok: false, code: 'PT404' });
      expect(ok(await read(s))).toEqual([]);
      await putDraft(s, 0);
      expect(await change(s, 'publish', 1, 0, 82)).toMatchObject({ ok: false, code: 'PT409' });
      expect(await change(s, 'restore_review', 1, 0, 83)).toMatchObject({ ok: false, code: 'PT409' });
      await checkPointer(s, 1, null);
      expect(await audit(s)).toEqual([]);
    });

    async function validationFields(slug: string): Promise<Record<string, unknown>> {
      const value = ok(await read(slug))[0]?.fields;
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Expected fixture fields');
      return value as Record<string, unknown>;
    }

    async function saveValidationRevision(
      slug: string,
      draft: number,
      meta: Record<string, unknown>,
      body: string,
    ) {
      const rows = ok(
        await run(
          db.pool,
          admin,
          'select * from public.az_cms_save_article_draft($1,$2,$3::jsonb,$4)',
          [slug, draft, JSON.stringify(meta), body],
          { commit: true },
        ),
      );
      expect(rows).toEqual([{ item_id: expect.any(String), revision: draft + 1 }]);
    }

    async function publishedSnapshot(slug: string) {
      const result = await db.pool.query(
        `select a.published_revision, r.fields, r.body_source
      from private.cms_article_items a join private.cms_article_revisions r
      on r.item_id = a.id and r.revision = a.published_revision where a.slug = $1`,
        [slug],
      );
      return result.rows;
    }

    it('applies the public 36-unit title budget and keeps the prior published revision on rejection', async () => {
      // Each atLimit is 72 half-units, using the site's code-point rule (< U+0100 costs one).
      const cases = [
        { label: 'han', atLimit: '文'.repeat(36), over: '文'.repeat(37) },
        { label: 'latin', atLimit: 'a'.repeat(72), over: 'a'.repeat(73) },
        { label: 'mixed', atLimit: '文'.repeat(34) + '😀é7', over: '文'.repeat(34) + '😀é7a' },
        {
          label: 'latin1',
          atLimit: '\u0100'.repeat(35) + '\u00ff\u00ff',
          over: '\u0100'.repeat(35) + '\u00ff\u00ff\u00ff',
        },
      ];
      for (const [i, { label, atLimit, over }] of cases.entries()) {
        const slug = `ci-release-title-${label}`;
        const key = 100 + i * 10;
        await putDraft(slug, 0);
        const fields = await validationFields(slug);
        const accepted = { ...fields, title: atLimit };
        await saveValidationRevision(slug, 1, accepted, ciBody(2));
        ok(await change(slug, 'submit_review', 2, 0, key));
        ok(await change(slug, 'publish', 2, 1, key + 1));
        const live = await publishedSnapshot(slug);
        expect(live).toEqual([{ published_revision: 2, fields: accepted, body_source: ciBody(2) }]);
        await saveValidationRevision(slug, 2, { ...fields, title: over }, ciBody(3));
        ok(await change(slug, 'submit_review', 3, 2, key + 2));
        const before = await audit(slug);
        expect(await change(slug, 'publish', 3, 3, key + 3)).toMatchObject({ ok: false, code: '22023' });
        expect(await publishedSnapshot(slug)).toEqual(live);
        expect(await audit(slug)).toEqual(before);
        expect(ok(await read(slug))[0]).toMatchObject({
          revision: 3,
          fields: { title: over },
          body_source: ciBody(3),
        });
      }
    });

    it('rejects whitespace-only required publication text while retaining the private draft and old public snapshot', async () => {
      const slug = 'ci-release-blank-text';
      await seedLive(slug, 200);
      const fields = await validationFields(slug);
      const live = await publishedSnapshot(slug);
      expect(live).toEqual([{ published_revision: 1, fields, body_source: ciBody(1) }]);
      const cases: { patch: Record<string, unknown>; body?: string }[] = [
        { patch: { author: '\u00a0\u3000' } },
        { patch: { category: '\t\r\n' } },
        { patch: {}, body: '\t\n\u3000' },
      ];
      for (const [i, sample] of cases.entries()) {
        const revision = i + 2;
        const genBeforeReview = i + 2;
        const meta = { ...fields, ...sample.patch };
        const body = sample.body ?? ciBody(revision);
        const key = 210 + i * 2;
        await saveValidationRevision(slug, revision - 1, meta, body);
        ok(await change(slug, 'submit_review', revision, genBeforeReview, key));
        const before = await audit(slug);
        expect(await change(slug, 'publish', revision, genBeforeReview + 1, key + 1)).toMatchObject({
          ok: false,
          code: '22023',
        });
        expect(ok(await read(slug))[0]).toMatchObject({ revision, fields: meta, body_source: body });
        expect(await publishedSnapshot(slug)).toEqual(live);
        expect(await audit(slug)).toEqual(before);
      }
    });
  },
);
