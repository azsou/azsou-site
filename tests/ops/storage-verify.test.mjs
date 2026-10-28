// 第六轮 ⑤：Storage 下载核验——缺可靠的内容 / 版本核验信息（eTag 是内容 md5 / 响应 ETag 相等 / 对象版本相等）→ 拒绝。
// node --test tests/ops/storage-verify.test.mjs（不联网、无依赖；PR #5 与运维 PR #8 共用）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RELIABLE, md5, overwriteReason } from '../../scripts/ops/storage-verify.mjs';

const body = Buffer.from('hello-azsou');
const H = (o = {}) => new Headers(o);
const MULTI = '0123456789abcdef0123456789abcdef-2';

test('md5 形式 eTag：内容 md5 一致 → 通过；同尺寸改写 → 拒绝', () => {
  assert.equal(overwriteReason({ etag: `"${md5(body)}"` }, H(), body), null);
  const evil = Buffer.from('hello-AZSOU');
  assert.equal(evil.length, body.length);
  assert.match(overwriteReason({ etag: md5(body) }, H(), evil), /内容 md5/);
});

test('分段 eTag + 响应 ETag 相等 → 通过；响应 ETag 不同 → 拒绝', () => {
  assert.equal(overwriteReason({ etag: MULTI }, H({ etag: `"${MULTI}"` }), body), null);
  assert.match(overwriteReason({ etag: MULTI }, H({ etag: '"ffff-2"' }), body), /响应 ETag/);
});

test('分段 eTag、响应没有 ETag、也没有版本可比 → 缺可靠核验信息，拒绝（以前会放行）', () => {
  assert.match(overwriteReason({ etag: MULTI }, H(), body), /缺可靠的内容 \/ 版本核验信息/);
  // 只有 Last-Modified 不算可靠核验
  assert.match(
    overwriteReason({ etag: MULTI, last_modified: '2026-10-28T00:00:00Z' }, H({ 'last-modified': 'Wed, 28 Oct 2026 00:00:00 GMT' }), body),
    /缺可靠/,
  );
});

test('分段 eTag + 对象版本相等 → 通过；版本不同 → 拒绝', () => {
  assert.equal(overwriteReason({ etag: MULTI, version: 'v-1' }, H({ 'x-amz-version-id': 'v-1' }), body), null);
  assert.match(overwriteReason({ etag: MULTI, version: 'v-1' }, H({ 'x-amz-version-id': 'v-2' }), body), /对象版本/);
});

test('快照没有 eTag / 没有记录 → 拒绝', () => {
  assert.match(overwriteReason(undefined, H(), body), /缺可靠/);
  assert.match(overwriteReason({ etag: '' }, H({ etag: md5(body) }), body), /缺可靠/);
});

test('Last-Modified 晚于快照 → 拒绝（即使 md5 一致）', () => {
  assert.match(
    overwriteReason(
      { etag: md5(body), last_modified: '2026-10-28T00:00:00Z' },
      H({ 'last-modified': 'Wed, 28 Oct 2026 00:10:00 GMT' }),
      body,
    ),
    /Last-Modified/,
  );
  assert.deepEqual(Object.values(RELIABLE).sort(), ['etag', 'md5', 'version']);
});
