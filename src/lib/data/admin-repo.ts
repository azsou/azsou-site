/**
 * 后台接口入口（只在后台页面的包里）。
 *
 * 以前 `createSupabaseRepository()` 直接把 `createAdminApi()` 挂在仓储对象的 `admin` 上，
 * 于是后台实现（几十个 RPC 封装、排序降级、迁移编号表……）进了所有公开页面共用的数据层 chunk——
 * 批次 1 / 2 的后台改动合并后，/apps/ 页面加载期间的 JS 涨到 49,229 B，超过 49,152 B 预算。
 * 现在仓储只暴露一条原始 REST 通道（`adminRest`），后台接口在这里按需创建；
 * 公开页面不 import 本文件，打包器就不会把后台代码放进它们的 chunk（tests/built/js-budget.test.ts 逐页检查）。
 */
import { createAdminApi, type AdminRepo, type AdminRest } from './admin';
import { migrationOf } from './schema-map';
import {
  DataUnavailableError,
  SchemaMissingError,
  UUID_RE,
  ValidationError,
  type DataRepository,
} from './types';

/** 数据层抛出的 SchemaMissingError 不带迁移编号（编号表不进公开包）；后台在这里补上 */
export function withMigration(e: unknown): unknown {
  if (!(e instanceof SchemaMissingError) || e.migration) return e;
  const migration = migrationOf(e.object);
  return migration ? new SchemaMissingError(e.object, e.code, migration) : e;
}

const rethrow = (e: unknown): never => {
  throw withMigration(e);
};

export type ArticleDraftFields = Record<string, unknown> & { title: string };

export interface ArticleDraftReceipt {
  itemId: string;
  revision: number;
}

export interface ArticleDraftInput {
  slug: string;
  expectedRevision: number;
  fields: ArticleDraftFields;
  bodySource: string;
}

export interface ArticleDraftRecord extends ArticleDraftReceipt {
  fields: ArticleDraftFields;
  bodySource: string;
}

export interface ArticleDraftApi {
  read(slug: string): Promise<ArticleDraftRecord | null>;
  save(input: ArticleDraftInput): Promise<ArticleDraftReceipt>;
}

type AdminWorkbench = AdminRepo & { articleDrafts: ArticleDraftApi };

const isRow = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function badDraftResponse() {
  return new DataUnavailableError('草稿回执不完整，请先重新读取', { kind: 'bad-response' });
}

function onlyRow(data: unknown): Record<string, unknown> {
  if (!Array.isArray(data) || data.length !== 1 || !isRow(data[0])) throw badDraftResponse();
  return data[0];
}

function draftReceipt(row: Record<string, unknown>): ArticleDraftReceipt {
  const { item_id: itemId, revision } = row;
  if (typeof itemId !== 'string' || !UUID_RE.test(itemId)) throw badDraftResponse();
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    throw badDraftResponse();
  }
  return { itemId, revision };
}

/** Only the station-admin workbench gets these methods. No publish call, cache or implicit retry. */
function createArticleDraftApi({ rest }: AdminRest): ArticleDraftApi {
  const post = (name: string, body: Record<string, unknown>) =>
    rest<unknown>(`rpc/${name}`, { method: 'POST', requireAuth: true, body });
  return {
    async read(slug) {
      const data = await post('az_cms_read_article_draft', { p_slug: slug });
      if (Array.isArray(data) && data.length === 0) return null;
      const row = onlyRow(data);
      const { fields, body_source: bodySource } = row;
      if (!isRow(fields) || typeof fields.title !== 'string' || !fields.title.trim()) {
        throw badDraftResponse();
      }
      if (typeof bodySource !== 'string') throw badDraftResponse();
      return { ...draftReceipt(row), fields: { ...fields, title: fields.title }, bodySource };
    },
    async save({ slug, expectedRevision, fields, bodySource }) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new ValidationError('草稿版本无效');
      }
      const data = await post('az_cms_save_article_draft', {
        p_slug: slug,
        p_expected_revision: expectedRevision,
        p_fields: fields,
        p_body_source: bodySource,
      });
      const saved = draftReceipt(onlyRow(data));
      if (saved.revision !== expectedRevision + 1) throw badDraftResponse();
      return saved;
    },
  };
}

const cache = new WeakMap<DataRepository, AdminWorkbench>();

/** 当前仓储的后台接口；适配器不支持后台（内存适配器）时返回 null */
export function adminApiFor(repo: DataRepository): AdminWorkbench | null {
  const raw = repo.adminRest;
  if (!raw) return null;
  let api = cache.get(repo);
  if (!api) {
    const rest: AdminRest = {
      rest: <T>(path: string, init?: Parameters<AdminRest['rest']>[1]) =>
        raw.rest<T>(path, init).catch(rethrow),
      restCount: (path, init) => raw.restCount(path, init).catch(rethrow),
    };
    api = Object.assign(createAdminApi(rest), { articleDrafts: createArticleDraftApi(rest) });
    cache.set(repo, api);
  }
  return api;
}
