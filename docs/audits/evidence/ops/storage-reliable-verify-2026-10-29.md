# 第六轮 ⑤：Storage 下载缺可靠核验信息 → 拒绝（2026-10-29）

`scripts/ops/storage-files.mjs download` 逐对象核对快照（`scripts/ops/storage-verify.mjs` 的 `overwriteReason`）。

| 情形                                                      | 修复前（63c4a9a） | 修复后                             |
| --------------------------------------------------------- | ----------------- | ---------------------------------- |
| 快照 eTag 是分段形式（`…-2`），响应没有 ETag，没有版本    | `null`（放行）    | 拒绝：缺可靠的内容 / 版本核验信息  |
| 同上，只有 Last-Modified 一致                             | `null`（放行）    | 拒绝（Last-Modified 不算可靠核验） |
| md5 eTag 与内容一致                                       | 放行              | 放行（md5）                        |
| 分段 eTag + 响应 ETag 相等                                | 放行              | 放行（etag）                       |
| 分段 eTag + 对象版本相等（x-amz-version-id）              | 放行              | 放行（version）                    |
| 版本不同 / 响应 ETag 不同 / md5 不同 / Last-Modified 更晚 | 部分拒绝          | 全部拒绝                           |

单测：`node --test tests/ops/storage-verify.test.mjs` 6/6（Ops tests lint 任务）。同一份 `storage-verify.mjs` 同步到运维 PR #8。
