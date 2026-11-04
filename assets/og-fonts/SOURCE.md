# OG 字体来源记录

## 上游

- 仓库：github.com/notofonts/noto-cjk（Noto Sans CJK 2.004）
- 素材 OG 两款固定提交：`523d033d6cb47f4a80c58a35753646f5c3608a78`，原始文件（raw.githubusercontent.com/notofonts/noto-cjk/<提交>/…）：

| 上游路径 | 完整文件 SHA256 | 大小 |
| --- | --- | --- |
| `Sans/SubsetOTF/SC/NotoSansSC-Black.otf` | `ccb496022356b7dd14d117538a472ae40feff8f6e8f3fe8bffc5616785d2f3f9` | 8855916 |
| `Sans/Mono/NotoSansMonoCJKsc-Regular.otf` | `ec04cc376b34887cedbdf84074e2e226ed2761eeabdcb9173fc1dd7bfd153ef7` | 16393784 |
| `LICENSE`（仓库根） | `6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2` | 4301 |

完整源字体不放进仓库。同目录 `LICENSE` 与上游 `LICENSE` 逐字节相同。
Regular / Bold 子集是早先（T9.4）从 `main` 分支的 SubsetOTF/SC 生成的，本次未重新生成，二进制不变（name 5 同为 Version 2.004，具体来源提交未记录）。

## 内部信息（Windows 平台 / 英语 name 记录）

| 文件 | name 1 | name 2 | name 16 | name 17 | name 6 | name 5 | usWeightClass |
| --- | --- | --- | --- | --- | --- | --- | --- |
| NotoSansSC-Black.otf（源与子集相同） | Noto Sans SC Black | Regular | Noto Sans SC | Black | NotoSansSC-Black | Version 2.004;hotconv 1.0.118;makeotfexe 2.5.65603 | 900 |
| NotoSansMonoCJKsc-Regular.otf（源与子集相同） | Noto Sans Mono CJK SC | Regular | — | — | NotoSansMonoCJKsc-Regular | Version 2.004;hotconv 1.0.118;makeotfexe 2.5.65603 | 400 |
| NotoSansSC-Regular.subset.otf | Noto Sans SC | Regular | — | — | NotoSansSC-Regular | Version 2.004;hotconv 1.0.118;makeotfexe 2.5.65603 | 400 |
| NotoSansSC-Bold.subset.otf | Noto Sans SC | Bold | — | — | NotoSansSC-Bold | Version 2.004;hotconv 1.0.118;makeotfexe 2.5.65603 | 700 |

渲染绑定按 fontdb 的规则取家族名：有 name 16（typographic family）用 16，否则用 name 1。
所以 Black 与 Regular / Bold 同属 “Noto Sans SC” 家族，按 usWeightClass 区分字重。

## 版权声明（name 0，四个文件相同）

© 2014-2021 Adobe (http://www.adobe.com/).

name 7：Noto is a trademark of Google Inc.

## 许可结论（OFL 1.1）

- 上游 `LICENSE` 只有 OFL 1.1 正文，没有 “with Reserved Font Name …” 声明；name 表里也没有声明保留字体名。
  因此 OFL 第 3 条（修改版不得使用保留字体名）对这些子集没有约束，子集保留原内部名不违反 OFL。
- 子集属于 OFL 定义的 “Modified Version”：必须继续以 OFL 1.1 发布（第 5 条），随附版权声明与许可全文（第 2 条），
  不得单独出售（第 1 条）。本目录随附 `LICENSE` 全文，版权声明保留在每个子集的 name 0 并记录于本文件。
- “Noto” 是 Google 的商标（name 7），与 OFL 无关；这里只是保留原名用于构建期渲染，不以该名义推广或分发字体产品。
- 子集保留全部 name 记录（`name_IDs=['*']`），不改名、不改版权字段。
