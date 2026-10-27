/**
 * I01 / T074：登录 / 回调后 ?next= 的外域绕过向量（单测与 e2e 共用一份）。
 *
 * 每一项在浏览器里如果被原样（或「规范化」后）交给 location.assign / replace，都会离开本站：
 * - 第 1 轮（b5795d9 已修）：制表符 / 换行被 WHATWG URL 解析删掉 → 协议相对地址 //evil.example
 * - 第 3 轮（本次）：点段（. / ..）规范化后剩下以 // 开头的路径 → 仍是协议相对地址；
 *   编码的点 / 斜杠 / 反斜杠（含二次编码）可能在某一层解码后变成同样的东西。
 */
export const EVIL_NEXT: readonly string[] = [
  // 绝对 / 协议相对 / 反斜杠
  'https://evil.example/',
  '//evil.example/x',
  '/\\evil.example',
  ' //evil.example',
  'javascript:alert(1)',
  // 第 1 轮：制表符 / 换行
  '/\t/evil.example',
  '/\n/evil.example',
  '/\r\n/evil.example',
  '/\t\\evil.example',
  // 第 3 轮：点段规范化
  '/.//evil.example',
  '/./%2F/evil',
  '/a/..//evil.example',
  '/%2e/%2fevil',
  '/..//evil',
  '/././/evil.example',
  '/..///evil.example',
  '/a/b/../..//evil.example',
  '/%2e//evil.example',
  '/%2E%2E//evil.example',
  '/.%2e//evil.example',
  '/%2e%2e/%2Fevil.example',
  // 编码斜杠 / 反斜杠 / 二次编码
  '/%2f%2fevil.example',
  '/%2F/evil.example',
  '/.%2f/evil.example',
  '/..%2f/evil.example',
  '/%252e//evil.example',
  '/%252f%252fevil.example',
  '/%25252f%25252fevil.example',
  '/%5cevil.example',
  '/%5c%5cevil.example',
  '/..%5c/evil.example',
  '/.%5c/evil.example',
  '/%255cevil.example',
  // 反斜杠混用（浏览器把特殊协议里的 \ 当作 /）
  '/.\\/evil.example',
  '/..\\\\evil.example',
  '/a/..\\/evil.example',
  // 编码的控制字符（某一层解码后才出现）
  '/%09/evil.example',
  '/%0a/evil.example',
  '/%250a/evil.example',
];

/** 带点段但规范化后仍在本站的合法路径：返回规范化结果，而不是原始输入 */
export const BENIGN_DOT_NEXT: readonly [string, string][] = [
  ['/a/../forum/', '/forum/'],
  ['/./articles/', '/articles/'],
  ['/forum/./new/?cat=tech', '/forum/new/?cat=tech'],
];
