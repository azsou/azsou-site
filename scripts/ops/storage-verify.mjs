// Storage 对象内容核验（纯函数，无网络、无环境依赖）——scripts/ops/storage-files.mjs 下载时用；
// PR #5（scripts/ops/）与运维 PR #8 共用同一份文件（第六轮 ⑤ 同步）。单测：tests/ops/storage-verify.test.mjs（node --test）。
import { createHash } from 'node:crypto';

export const md5 = (buf) => createHash('md5').update(buf).digest('hex');
export const normEtag = (e) =>
  String(e ?? '')
    .trim()
    .replace(/^W\//, '')
    .replace(/^"+|"+$/g, '')
    .toLowerCase();

/**
 * 同尺寸改写检测（第五轮 ②，第六轮 ⑤ 收紧）：对象在快照之后被换成**大小相同、内容不同**的文件时，只比大小发现不了。
 * 必须有至少一个**可靠的内容 / 版本核验**真正比对过，否则拒绝（不是「没发现问题就算一致」）：
 *   A. 快照 eTag 是 md5 形式（32 位十六进制，单段上传）→ 与下载内容的 md5 比对；
 *   B. 快照 eTag 是分段形式（"…-N"，不是内容 md5）→ 必须有响应 ETag 且与之相等；
 *   C. 快照记录了 version，且响应头带同一个对象版本（x-amz-version-id / x-object-version）→ 相等。
 * 另外：响应 ETag 与快照不同、Last-Modified 晚于快照 → 一律视为改写。
 * 快照没有 eTag、或只有分段 eTag 而响应没给 ETag（也没有版本可比）→ 「缺可靠核验信息」，拒绝。
 * 返回 null = 一致且至少一项可靠核验通过；否则返回原因。
 */
export const RELIABLE = Object.freeze({ MD5: 'md5', ETAG: 'etag', VERSION: 'version' });
export function overwriteReason(snap, resHeaders, buf) {
  if (!snap) return '快照里没有这个对象的 eTag 记录，缺可靠的内容 / 版本核验信息';
  const se = normEtag(snap.etag);
  if (!se) return '快照里这个对象没有 eTag，缺可靠的内容 / 版本核验信息';
  const he = normEtag(resHeaders.get('etag'));
  if (he && he !== se) return `响应 ETag ${he} ≠ 快照 eTag ${se}`;
  const lm = Date.parse(resHeaders.get('last-modified') ?? '');
  const sm = Date.parse(snap.last_modified || snap.updated_at || '');
  if (Number.isFinite(lm) && Number.isFinite(sm) && lm - sm > 1000)
    return `Last-Modified ${new Date(lm).toISOString()} 晚于快照记录 ${new Date(sm).toISOString()}`;
  const verified = [];
  if (/^[0-9a-f]{32}$/.test(se)) {
    if (md5(buf) !== se) return `内容 md5 ${md5(buf)} ≠ 快照 eTag ${se}`;
    verified.push(RELIABLE.MD5);
  }
  if (he && he === se) verified.push(RELIABLE.ETAG);
  const sv = String(snap.version ?? '').trim();
  const hv = String(resHeaders.get('x-amz-version-id') ?? resHeaders.get('x-object-version') ?? '').trim();
  if (sv && hv) {
    if (sv !== hv) return `对象版本 ${hv} ≠ 快照版本 ${sv}`;
    verified.push(RELIABLE.VERSION);
  }
  if (!verified.length)
    return `缺可靠的内容 / 版本核验信息：快照 eTag ${se} 不是内容 md5（分段上传），响应没有 ETag，也没有可比的对象版本——无法证明下载内容就是快照里的那份`;
  return null;
}

