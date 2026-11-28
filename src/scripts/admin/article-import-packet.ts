import type { ArticleDraftFields, ArticleDraftRecord } from '@/lib/data/admin-repo';

type Packet = { slug: string; fields: ArticleDraftFields; bodySource: string };

const row = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown) => Array.isArray(v) && v.every((entry) => typeof entry === 'string');
const nullableText = (v: unknown) => v === null || typeof v === 'string';
const textKeys = ['title', 'category', 'badge', 'author', 'date', 'lastChecked', 'ogImage', 'pinyin'];

// This deliberately narrow format accepts the 14-field pilot only. Never silently drop optional fields.
function knownFields(v: unknown): v is ArticleDraftFields {
  if (!row(v) || Object.keys(v).length !== 14 || !textKeys.every((k) => typeof v[k] === 'string'))
    return false;
  return (
    typeof v.title === 'string' &&
    v.title.trim().length > 0 &&
    strings(v.toc) &&
    strings(v.tags) &&
    nullableText(v.art) &&
    nullableText(v.forumThread) &&
    typeof v.readingMinutes === 'number' &&
    Number.isSafeInteger(v.readingMinutes) &&
    v.readingMinutes > 0 &&
    typeof v.order === 'number' &&
    Number.isSafeInteger(v.order)
  );
}

/** Read a reviewed, canonical UTF-8 JSON file as data. No network, HTML rendering, or client persistence. */
export async function readImportPacket(file: File, slug: string, expected: string): Promise<Packet> {
  const bad = () => new Error('导入文件与核对单不符');
  if (
    file.name !== `${slug}.json` ||
    file.size < 1 ||
    file.size > 131072 ||
    !/^[a-f0-9]{64}$/.test(expected)
  ) {
    throw bad();
  }
  const bytes = await file.arrayBuffer();
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(hash, (n) => n.toString(16).padStart(2, '0')).join('');
  if (hex !== expected) throw bad();
  const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const v: unknown = JSON.parse(raw);
  if (!row(v) || v.p_slug !== slug || v.p_expected_revision !== 0 || !knownFields(v.p_fields)) throw bad();
  if (typeof v.p_body_source !== 'string' || !v.p_body_source.length) throw bad();
  const fields = v.p_fields;
  const sorted = Object.fromEntries(
    Object.keys(fields)
      .sort()
      .map((k) => [k, fields[k]]),
  );
  // Also rejects duplicate keys, unexpected envelope keys and noncanonical encodings, without repairing data.
  const canonical = {
    p_body_source: v.p_body_source,
    p_expected_revision: 0,
    p_fields: sorted,
    p_slug: slug,
  };
  if (JSON.stringify(canonical) !== raw) throw bad();
  return { slug, fields, bodySource: v.p_body_source };
}

// The pilot field values are scalars or ordered string lists; JSONB object-key order is not significant.
export function matchesImport(record: ArticleDraftRecord, packet: Packet): boolean {
  const keys = Object.keys(packet.fields);
  return (
    record.bodySource === packet.bodySource &&
    Object.keys(record.fields).length === keys.length &&
    keys.every((k) => JSON.stringify(record.fields[k]) === JSON.stringify(packet.fields[k]))
  );
}
