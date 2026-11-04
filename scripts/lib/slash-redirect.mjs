/**
 * 测试 / 预览静态服务器（scripts/serve.mjs）补 / 去尾斜杠时的 Location（I01 / T074 第 3 轮）。
 *
 * 以前 Location 用的是「解码后」的路径：/%2F/evil.example 解码成 //evil.example，补斜杠后 308 → Location: //evil.example/
 * ——协议相对地址，浏览器跳到外域（开放重定向；登录回调的 ?next= 走到这里同样会离站）。
 * 现在：用原始（仍编码）的路径拼 Location，开头连续的 / 或 \ 折叠成一个，最后再按 URL 解析确认同源，否则回首页。
 *
 * @param {string} encodedPathname new URL(req.url).pathname（未解码）
 * @param {string} search 原样带上的查询串（含 ?，可为空）
 * @param {'add' | 'strip'} mode 补尾斜杠 / 去尾斜杠
 * @returns {string}
 */
export function slashRedirect(encodedPathname, search, mode) {
  let loc = mode === 'add' ? `${encodedPathname}/` : encodedPathname.replace(/\/$/, '');
  loc = `/${loc.replace(/^[/\\]+/, '')}`;
  const base = 'http://same.invalid';
  try {
    const u = new URL(loc, base);
    if (u.origin !== base || u.pathname.startsWith('//')) return '/';
  } catch {
    return '/';
  }
  return loc + (search || '');
}
