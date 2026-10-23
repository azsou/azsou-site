import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures';
import { ROUTES } from './routes';

/**
 * axe 无障碍检查（WCAG 2.1 A/AA）。为控制时长，每个引擎只跑桌面与 iPhone 两个视口
 * （平板/安卓与这两个共用同一套 CSS 断点）。设置 A11Y_ALL=1 可在全部 12 个项目上跑。
 */
for (const route of ROUTES) {
  test(`a11y ${route}`, async ({ page }, info) => {
    test.skip(!process.env.A11Y_ALL && !/-(desktop|iphone)$/.test(info.project.name), '仅桌面与 iPhone 视口');
    await page.goto(route);
    await page.waitForLoadState('networkidle');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const summary = results.violations.map(
      (v) =>
        `${v.id} (${v.impact}): ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(' '))
          .join(' | ')}`,
    );
    expect(summary).toEqual([]);
  });
}
