/**
 * Decap CMS 扩展（T9.17，DESIGN-SYSTEM §15）：
 *  - string-count 控件：实时字数（zhLength）+ 计数器 + 超限红字；isValid 拦住超字数保存；
 *  - icon-path 控件：图标路径 + 56 / 112 两档预览（垫板 + 安全区参考线）+ 规格指引；
 *  - 预览模板（应用 / AI 工具 / 文章）：用站点真实 CSS（读首页 <link rel=stylesheet>）渲染卡片，
 *    显示截断效果，并附线上地址（slug）、分享卡（OG）预览与字数检查表；
 *  - 顶栏说明草稿 → 待审核 → 就绪 → 合并上线（editorial_workflow）。
 * 纯逻辑在 ./cms-core.js（单元测试覆盖）；这里只做 Decap / React 的接线。不用内联脚本（/cms/ CSP）。
 */
import { checkLength, counterText, IMAGE_GUIDE, pagePreview } from './cms-core.js';

const CMS = window.CMS;
const h = window.h;
const createClass = window.createClass;

// ------------------------------------------------------------ 字数控件 ----
const opt = (field, k) => (field && field.get ? field.get(k) : undefined);
const limitsOf = (field) => ({
  min: opt(field, 'min'),
  max: opt(field, 'max'),
  mode: opt(field, 'count') || 'zh',
  required: opt(field, 'required') !== false,
});

const StringCount = createClass({
  isValid() {
    const r = checkLength(this.props.value, limitsOf(this.props.field));
    return r.ok ? true : { error: { message: `${opt(this.props.field, 'label')}：${r.message}` } };
  },
  render() {
    const { field, value, onChange, forID, classNameWrapper, setActiveStyle, setInactiveStyle } = this.props;
    const lim = limitsOf(field);
    const checked = checkLength(value, lim);
    // 还没填：中性提示（保存时由必填 / isValid 拦），不一打开就满屏红字
    const r = value ? checked : { ...checked, ok: true, state: 'empty', message: lim.required ? '必填' : '' };
    const multiline = !!opt(field, 'multiline');
    const counterId = `${forID}-count`;
    const input = h(multiline ? 'textarea' : 'input', {
      id: forID,
      className: classNameWrapper,
      value: value || '',
      rows: multiline ? 3 : undefined,
      type: multiline ? undefined : 'text',
      'aria-describedby': counterId,
      'aria-invalid': r.ok ? 'false' : 'true',
      onChange: (e) => onChange(e.target.value),
      onFocus: setActiveStyle,
      onBlur: setInactiveStyle,
    });
    return h(
      'div',
      { className: 'azc-count' },
      input,
      h(
        'p',
        { id: counterId, className: `azc-count__meta azc-count__meta--${r.state}`, 'aria-live': 'polite' },
        h(
          'span',
          { className: 'azc-count__msg' },
          r.message || (lim.mode === 'chars' ? '按字符计' : '汉字 1、字母数字 0.5'),
        ),
        h('span', { className: 'azc-count__n' }, counterText(r.n, lim)),
      ),
    );
  },
});
CMS.registerWidget('string-count', StringCount, (props) => h('span', {}, props.value || ''));

// ------------------------------------------------------------ 图标控件 ----
const IconPath = createClass({
  render() {
    const { value, onChange, forID, classNameWrapper, setActiveStyle, setInactiveStyle } = this.props;
    const src = value || '';
    const tile = (px) =>
      h(
        'span',
        { className: 'azc-icon__tile', style: { width: px, height: px } },
        src ? h('img', { src, alt: '', width: px, height: px }) : null,
        h('span', { className: 'azc-icon__safe', 'aria-hidden': 'true' }),
      );
    return h(
      'div',
      { className: 'azc-icon' },
      h('input', {
        id: forID,
        className: classNameWrapper,
        type: 'text',
        value: src,
        placeholder: '/apps/icons/<slug>.png',
        onChange: (e) => onChange(e.target.value),
        onFocus: setActiveStyle,
        onBlur: setInactiveStyle,
      }),
      h(
        'div',
        { className: 'azc-icon__row' },
        tile(56),
        tile(112),
        h('p', { className: 'azc-hint' }, IMAGE_GUIDE.icon),
      ),
    );
  },
});
CMS.registerWidget('icon-path', IconPath, (props) => h('code', {}, props.value || ''));

// ------------------------------------------------------------ 预览模板 ----
const get = (entry, path) => {
  const v = entry.getIn(['data', ...path]);
  return v && v.toJS ? v.toJS() : v;
};

/** 字数检查表：哪个字段超了一目了然（与保存拦截同一规则） */
function lengthTable(entry, rows) {
  return h(
    'table',
    { className: 'azc-check' },
    h('caption', {}, '字数检查（汉字 1、字母数字 0.5）'),
    h(
      'tbody',
      {},
      ...rows.map(([label, path, lim]) => {
        const r = checkLength(get(entry, path), lim);
        return h(
          'tr',
          { key: label, className: `azc-check--${r.state}` },
          h('th', { scope: 'row' }, label),
          h('td', {}, counterText(r.n, lim)),
          h('td', {}, r.ok ? (r.state === 'near' ? '接近上限' : '✓') : r.message),
        );
      }),
    ),
  );
}

function pageBlock(collection, entry) {
  const p = pagePreview(collection, entry.get('data').toJS(), entry.get('slug'));
  return h(
    'section',
    { className: 'azc-page' },
    h('h2', { className: 'azc-h' }, '线上地址与分享卡'),
    h(
      'p',
      { className: 'azc-url' },
      p.url,
      p.tentative ? h('span', { className: 'azc-tag' }, '保存后确定') : null,
    ),
    h(
      'div',
      { className: 'azc-og' },
      h('img', { src: p.ogImage, alt: '', width: 1200, height: 630, className: 'azc-og__img' }),
      h(
        'div',
        { className: 'azc-og__body' },
        h('p', { className: 'azc-og__site' }, 'azsou.com'),
        h('p', { className: 'azc-og__title' }, p.ogTitle),
        h('p', { className: 'azc-og__desc' }, p.ogDescription || '（简介为空时搜索引擎会自己截取正文）'),
      ),
    ),
  );
}

const draftNote = () =>
  h(
    'p',
    { className: 'azc-draft' },
    '预览 = 线上卡片的真实样式（含截断）。保存只会在 GitHub 开草稿 PR；「就绪」后由站长合并才会上线。',
  );

const AppPreview = createClass({
  render() {
    const e = this.props.entry;
    const t = (p) => get(e, p) || '';
    return h(
      'div',
      { className: 'azc' },
      draftNote(),
      h('h2', { className: 'azc-h' }, '应用卡片（列表 / 首页）'),
      h(
        'div',
        { className: 'grid grid--wide azc-grid' },
        h(
          'article',
          { className: 'card card--row card--hue app-card', 'data-hue': t(['hue']) || 'accent' },
          h('img', {
            className: 'app-icon-img app-icon-img--56',
            src: t(['icon', 'src']),
            alt: '',
            width: 56,
            height: 56,
          }),
          h(
            'div',
            { className: 'card__body' },
            h(
              'h3',
              { className: 'card__title' },
              h('a', { className: 'card__link', href: '#' }, t(['title']) || '（名称）'),
            ),
            h('p', { className: 'card__text' }, t(['tagline']) || '（卡片一句话）'),
            h(
              'div',
              { className: 'card__meta' },
              h('span', {}, t(['category'])),
              h('span', {}, ' · '),
              h('span', {}, t(['status'])),
            ),
          ),
        ),
      ),
      h('h2', { className: 'azc-h' }, '简介（精选卡 2 行截断）'),
      h('p', { className: 'card__text azc-clamp2' }, t(['summary'])),
      lengthTable(e, [
        ['名称', ['title'], { max: 14 }],
        ['卡片一句话', ['tagline'], { min: 6, max: 16 }],
        ['简介', ['summary'], { min: 32, max: 56 }],
        ['副标题', ['subtitle'], { max: 30, mode: 'chars' }],
      ]),
      pageBlock('apps', e),
    );
  },
});

const ToolPreview = createClass({
  render() {
    const e = this.props.entry;
    const t = (p) => get(e, p) || '';
    return h(
      'div',
      { className: 'azc' },
      draftNote(),
      h('h2', { className: 'azc-h' }, 'AI 工具卡片'),
      h(
        'div',
        { className: 'grid azc-grid' },
        h(
          'article',
          { className: 'card card--hue tool-card', 'data-hue': t(['hue']) || 'accent' },
          h(
            'div',
            { className: 'tool-card__head' },
            h('img', {
              className: 'app-icon-img app-icon-img--56',
              src: t(['icon', 'src']),
              alt: '',
              width: 56,
              height: 56,
            }),
            h(
              'div',
              {},
              h(
                'h3',
                { className: 'card__title' },
                h('a', { className: 'card__link', href: '#' }, t(['title']) || '（名称）'),
              ),
              h('p', { className: 'tool-card__dev' }, t(['developer', 'short']) || t(['developer', 'name'])),
            ),
          ),
          h('p', { className: 'card__text tool-card__summary' }, t(['summary']) || '（一句话简介）'),
        ),
      ),
      lengthTable(e, [
        ['名称', ['title'], { max: 14 }],
        ['卡片一句话', ['tagline'], { min: 6, max: 16 }],
        ['简介', ['summary'], { min: 40, max: 64 }],
        ['开发者短名', ['developer', 'short'], { max: 12, required: false }],
      ]),
      pageBlock('tools', e),
    );
  },
});

const ArticlePreview = createClass({
  render() {
    const e = this.props.entry;
    const t = (p) => get(e, p) || '';
    return h(
      'div',
      { className: 'azc' },
      draftNote(),
      h('h2', { className: 'azc-h' }, '文章卡片（媒体卡 2 行标题）'),
      h(
        'div',
        { className: 'grid azc-grid' },
        h(
          'article',
          { className: 'card card--media article-card' },
          h(
            'div',
            { className: 'card__body' },
            h('h3', { className: 'card__title azc-clamp2' }, t(['title']) || '（标题）'),
            h('p', { className: 'card__text azc-clamp2' }, t(['description'])),
          ),
        ),
      ),
      lengthTable(e, [
        ['标题', ['title'], { max: 36 }],
        ['摘要', ['description'], { min: 60, max: 110, required: false }],
      ]),
      pageBlock('articles', e),
      h('h2', { className: 'azc-h' }, '正文'),
      h('div', { className: 'prose' }, this.props.widgetFor('body')),
    );
  },
});

CMS.registerPreviewTemplate('apps', AppPreview);
CMS.registerPreviewTemplate('tools', ToolPreview);
CMS.registerPreviewTemplate('articles', ArticlePreview);

// 预览 iframe 的样式：token（preview.css）+ 站点真实 CSS + 预览辅助样式。
// 站点 CSS 在构建时内联进页面（<style>），文件名带哈希：读首页与 /ai/ 的样式原样注入，卡片与线上一致。
CMS.registerPreviewStyle('/cms/preview.css');
CMS.registerPreviewStyle('/cms/preview-extra.css');
for (const page of ['/', '/ai/'])
  fetch(page, { credentials: 'omit' })
    .then((r) => (r.ok ? r.text() : ''))
    .then((html) => {
      for (const m of html.matchAll(/<link[^>]+href="(\/_astro\/[^"]+\.css)"/g))
        CMS.registerPreviewStyle(m[1]);
      for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g))
        if (m[1].includes('.card')) CMS.registerPreviewStyle(m[1], { raw: true });
    })
    .catch(() => {
      // 读不到页面（本地 decap-server 模式等）：只用 token 样式，卡片结构仍然正确
    });
