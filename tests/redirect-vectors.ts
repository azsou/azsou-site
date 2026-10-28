/**
 * I01 / T074：登录 / 回调后 ?next= 的外域绕过向量（单测与 e2e 共用一份）。
 *
 * 每一项在浏览器里如果被原样（或「规范化」后）交给 location.assign / replace，都会离开本站：
 * - 第 1 轮（b5795d9 已修）：制表符 / 换行被 WHATWG URL 解析删掉 → 协议相对地址 //evil.example
 * - 第 3 轮（本次）：点段（. / ..）规范化后剩下以 // 开头的路径 → 仍是协议相对地址；
 *   编码的点 / 斜杠 / 反斜杠（含二次编码）可能在某一层解码后变成同样的东西。
 */
import { BENIGN_DOT_NEXT as BENIGN, EVIL_NEXT as EVIL } from '../scripts/i01/redirect-vectors.mjs';

// 数据在 scripts/i01/redirect-vectors.mjs（I01 真实验收执行器也读它，T074 人工证据必须覆盖全表）
export const EVIL_NEXT: readonly string[] = EVIL;
export const BENIGN_DOT_NEXT: readonly (readonly [string, string])[] = BENIGN;
