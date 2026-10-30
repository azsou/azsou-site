'use strict';
/**
 * Lighthouse 证据留存钩子（r18）。只在 lhci-tier.sh 的 collect 步骤里通过 NODE_OPTIONS=--require 预加载。
 *
 * 为什么需要它（依据 @lhci/cli 0.15.1 源码）：
 *   - LHCI 每个样本都用 `node <lighthouse>/cli/index.js <url> --output json --output-path stdout --cli-flags-path <json>` 起一个子进程
 *     （src/collect/node-runner.js 第 44–74、96–98 行），子进程退出码非 0 时 runUntilSuccess 会**静默重试**，最多 3 次，
 *     日志里只打印一次 "Run #k...done."（node-runner.js 第 134–147 行、collect.js 第 130–148 行）；
 *   - Lighthouse 12.6.1 在 --output-path stdout 时把 saveAssets 的 trace / devtools 日志写到**子进程当前目录**，
 *     文件名前缀 = 主机名 + fetchTime 精确到秒（cli/run.js 第 137、150–156 行；report/generator/file-namer.js 第 20–44 行）。
 *
 * 这个钩子只在 Lighthouse CLI 子进程里生效（argv[1] 以 lighthouse/cli/index.js 结尾，且设置了 LH_ATTEMPT_DIR），
 * lhci 自己、静态服务器（startServerCommand）等其他 node 进程里什么都不做。生效时：
 *   1. 在 attempts.jsonl 追加一条 start 记录：全局尝试序号、计划样本序号、URL、pid、CHROME_PATH（LHCI 选定后传给子进程的浏览器路径）、
 *      GitHub run_id / run_attempt（与 LHCI 内部尝试分开记录）；
 *   2. 如果上一次尝试是同一 URL 且没有以退出码 0 结束（含没有退出记录 = 被杀），这次就是 LHCI 的内部重试：
 *      记一条 exit（97，internal-retry-blocked）后立即退出，**不启动浏览器、不产生第二个测量值**。
 *      结果：每个计划样本最多一次真实测量；失败样本原样保留，LHCI 随后按自身逻辑让 collect 失败（本档失败）。
 *   3. 切到本次尝试自己的目录 attempt-NNN/，于是 saveAssets 的 trace / devtools 日志落在这里，不会落到仓库根目录，
 *      也不会与别的样本、别的档同名覆盖；
 *   4. 把子进程的 stdout（= LHR JSON，与 LHCI 存的 lhr-*.json 逐字节相同）和 stderr（Lighthouse 日志）同时写进
 *      attempt-NNN/stdout.json、stderr.log —— 失败的尝试（退出码非 0，LHCI 不保存它的 LHR）也留下；
 *   5. 退出时追加 exit 记录（退出码、结束时间、tee 是否出错）。
 * 钩子任何一步出错都不会让测量静默继续：记录写不进去就以 98 退出（该样本失败，LHCI 不会把它当成成功）。
 * 不读取、不记录任何凭据或环境变量全集。
 */
const fs = require('fs');
const path = require('path');

const dir = process.env.LH_ATTEMPT_DIR;
const entry = process.argv[1] || '';

if (dir && /[\\/]lighthouse[\\/]cli[\\/]index\.js$/.test(entry)) {
  const log = path.join(dir, 'attempts.jsonl');
  const now = () => new Date().toISOString();
  const append = (rec) => fs.appendFileSync(log, `${JSON.stringify(rec)}\n`);
  let n = 0;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const prev = fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
    const starts = prev.filter((r) => r.ev === 'start');
    const exits = new Map(prev.filter((r) => r.ev === 'exit').map((r) => [r.attempt, r]));
    n = starts.length + 1;
    const url = process.argv[2];
    const last = starts[starts.length - 1];
    const lastExit = last ? exits.get(last.attempt) : undefined;
    const retry = Boolean(last) && last.url === url && !(lastExit && lastExit.code === 0);
    const planned = retry ? last.planned : starts.filter((s) => !s.retry).length + 1;
    const rec = {
      ev: 'start',
      attempt: n,
      planned,
      retry,
      url,
      tier: process.env.LH_ATTEMPT_TIER || null,
      pid: process.pid,
      ppid: process.ppid,
      t: now(),
      chromePath: process.env.CHROME_PATH || null,
      node: process.version,
      githubRunId: process.env.GITHUB_RUN_ID || null,
      githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    };
    append(rec);
    if (retry) {
      append({ ev: 'exit', attempt: n, code: 97, reason: 'internal-retry-blocked', t: now() });
      process.stderr.write(
        `[lhci-attempt-hook] 第 ${n} 次尝试是 LHCI 对计划样本 #${planned}（${url}）的内部重试：已阻止，不启动浏览器\n`,
      );
      process.exit(97);
    }
    const adir = path.join(dir, `attempt-${String(n).padStart(3, '0')}`);
    fs.mkdirSync(adir); // 已存在 → 抛错 → 98（绝不覆盖）
    const outFd = fs.openSync(path.join(adir, 'stdout.json'), 'wx');
    const errFd = fs.openSync(path.join(adir, 'stderr.log'), 'wx');
    process.chdir(adir);
    let teeError = null;
    const tee = (stream, fd) => {
      const orig = stream.write.bind(stream);
      stream.write = function (chunk, enc, cb) {
        try {
          fs.writeSync(fd, typeof chunk === 'string' ? Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8') : chunk);
        } catch (e) {
          teeError = teeError || String((e && e.message) || e);
        }
        return orig(chunk, enc, cb);
      };
    };
    tee(process.stdout, outFd);
    tee(process.stderr, errFd);
    process.on('exit', (code) => {
      try {
        fs.closeSync(outFd);
        fs.closeSync(errFd);
      } catch (e) {
        teeError = teeError || String((e && e.message) || e);
      }
      append({ ev: 'exit', attempt: n, code, teeError, t: now() });
    });
  } catch (e) {
    try {
      append({ ev: 'exit', attempt: n, code: 98, reason: 'hook-error', error: String((e && e.message) || e), t: now() });
    } catch {
      /* 连记录都写不进：仍以 98 退出，LHCI 会把这个样本当失败 */
    }
    process.stderr.write(`[lhci-attempt-hook] 证据留存钩子出错：${(e && e.message) || e}；本次尝试以 98 退出（不测量）\n`);
    process.exit(98);
  }
}
