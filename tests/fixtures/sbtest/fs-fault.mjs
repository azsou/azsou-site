/**
 * 第十一轮：只给本机 CLI 回归用的文件系统故障注入（node --import 预加载，测试进程起子进程时才用）。
 * 只对文件名正好等于 SBTEST_FS_FAULT_NAME 的交接文件生效，其他文件系统调用原样放行：
 *  - SBTEST_FS_FAULT=write-enospc：交接文件以追加方式打开后，writeSync 抛 ENOSPC（模拟账号已建后交接写入失败）
 *  - SBTEST_FS_FAULT=unlink-eacces：unlinkSync 删除交接文件时抛 EACCES（模拟空交接文件删除失败）
 *  - SBTEST_FS_FAULT=record-enospc（第十二轮）：writeFileSync 写名为 SBTEST_FS_FAULT_NAME 的运行记录时抛 ENOSPC（模拟审计记录写入失败）
 *  - SBTEST_FS_FAULT=record-esecret（第十四轮）：同上，但抛的 Error 的 code 是允许清单外、像错误码的合成值 ESECRETDEMO42，
 *    消息里带合成标记——执行器只能输出 other，不能回显 code 或消息
 * 不连网络、不碰任何真实项目；执行器本身没有任何测试后门。
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

const mode = process.env.SBTEST_FS_FAULT;
const name = process.env.SBTEST_FS_FAULT_NAME;
const hit = (p) => typeof p === 'string' && !!name && path.basename(p) === name;
const err = (code, call, p) =>
  Object.assign(new Error(`${code}: injected fault (sbtest fs-fault), ${call} '${p}'`), {
    code,
    syscall: call,
    path: p,
  });

if (mode === 'write-enospc' && name) {
  const tracked = new Set();
  const { openSync, writeSync, closeSync } = fs;
  fs.openSync = function (p, flags, ...rest) {
    const fd = openSync.call(this, p, flags, ...rest);
    if (hit(p) && typeof flags === 'number' && flags & fs.constants.O_APPEND) tracked.add(fd);
    return fd;
  };
  fs.writeSync = function (fd, ...rest) {
    if (tracked.has(fd)) throw err('ENOSPC', 'write', name);
    return writeSync.call(this, fd, ...rest);
  };
  fs.closeSync = function (fd) {
    tracked.delete(fd);
    return closeSync.call(this, fd);
  };
} else if (mode === 'unlink-eacces' && name) {
  const { unlinkSync } = fs;
  fs.unlinkSync = function (p) {
    if (hit(p)) throw err('EACCES', 'unlink', p);
    return unlinkSync.call(this, p);
  };
} else if ((mode === 'record-enospc' || mode === 'record-esecret') && name) {
  const { writeFileSync } = fs;
  const code = mode === 'record-esecret' ? 'ESECRETDEMO42' : 'ENOSPC';
  fs.writeFileSync = function (p, ...rest) {
    if (hit(p)) throw err(code, 'write', name);
    return writeFileSync.call(this, p, ...rest);
  };
}
// 执行器用具名导入（import { writeSync, unlinkSync } from 'node:fs'）：同步到 ESM 具名导出
syncBuiltinESMExports();
