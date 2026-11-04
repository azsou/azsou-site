/**
 * E2E 服务器端口（playwright.config.ts 与需要自建 browser.newContext 的用例共用，避免各处写死 4321）。
 * 本地多个工作区并行跑时错开端口；CI 不设，默认 4321。
 * 整合候选：#5 用 E2E_PORT、#6 用 PW_PORT，两者都认（PW_PORT 优先）。
 */
export const PORT = Number(process.env.PW_PORT) || Number(process.env.E2E_PORT) || 4321;
export const BASE_URL = `http://127.0.0.1:${PORT}`;
