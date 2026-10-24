import { getRepository } from '@/lib/data';
import { commentNode, setStatus } from './render';

async function hydrate(root: HTMLElement) {
  const key = root.dataset.pageKey!;
  const list = root.querySelector('[data-list]')!;
  const count = root.querySelector('[data-count]');
  const seeds = list.querySelectorAll('[data-source="seed"]').length;
  try {
    const rows = await getRepository().comments.list(key);
    rows.forEach((r) => list.append(commentNode(r)));
    if (count) count.textContent = `${seeds + rows.length} 条`;
    setStatus(root, '只读预览：账户系统已上线，发表评论将在论坛与评论系统（v2 P3）上线后开放。', 'online');
  } catch {
    setStatus(root, '数据服务暂时不可达，当前为只读模式：仅显示站点预置内容。', 'offline');
  }
}

document.querySelectorAll<HTMLElement>('[data-comments]').forEach((r) => void hydrate(r));
