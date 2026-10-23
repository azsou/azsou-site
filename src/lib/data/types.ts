/**
 * 仓储接口：前端只依赖这些接口，不直接依赖 Supabase。
 * 换数据库 = 新写一个实现这些接口的适配器（见 supabase.ts / memory.ts）。
 * P1 只用到只读方法；写入、鉴权（AuthProvider）、UserRepo 在 P2 补齐。
 */
export interface Author {
  id: string | null;
  name: string;
  /** 站长/官方内容 */
  site?: boolean;
}

export interface Thread {
  id: string;
  category: string; // 分类 id：announce | product | tech | meta
  title: string;
  body: string; // 纯文本（渲染时转义）
  author: Author;
  pinned: boolean;
  createdAt: string; // ISO
}

export interface Reply {
  id: string;
  threadId: string;
  body: string;
  author: Author;
  createdAt: string;
}

export interface Comment {
  id: string;
  pageKey: string; // 例：article:pinyin-initial-search
  body: string;
  author: Author;
  createdAt: string;
}

export interface ForumRepo {
  listThreads(opts?: { category?: string; limit?: number }): Promise<Thread[]>;
  getThread(id: string): Promise<Thread | null>;
  listReplies(threadId: string): Promise<Reply[]>;
  replyCounts(): Promise<Record<string, number>>;
}

export interface CommentRepo {
  list(pageKey: string): Promise<Comment[]>;
}

export interface DataRepository {
  readonly name: string;
  forum: ForumRepo;
  comments: CommentRepo;
}

/** 后端不可达时抛出，UI 进入只读/离线提示 */
export class DataUnavailableError extends Error {
  constructor(message = '数据服务暂时不可达') {
    super(message);
    this.name = 'DataUnavailableError';
  }
}

/** 旧站分类以中文名存库（cat='产品讨论'），这里统一成 id */
export const CATEGORY_IDS: Record<string, string> = {
  公告: 'announce',
  产品讨论: 'product',
  技术交流: 'tech',
  站务反馈: 'meta',
};
export const categoryId = (cat: string) =>
  CATEGORY_IDS[cat] ?? (Object.values(CATEGORY_IDS).includes(cat) ? cat : 'meta');
