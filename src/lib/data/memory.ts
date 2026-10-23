import type { Comment, DataRepository, Reply, Thread } from './types';

export interface MemorySeed {
  threads?: Thread[];
  replies?: Reply[];
  comments?: Comment[];
}

const byDateDesc = (a: { createdAt: string }, b: { createdAt: string }) => b.createdAt.localeCompare(a.createdAt);
const byDateAsc = (a: { createdAt: string }, b: { createdAt: string }) => a.createdAt.localeCompare(b.createdAt);

/** 内存适配器：单元测试、离线开发、以及换库前的契约基准。 */
export function createMemoryRepository(seed: MemorySeed = {}): DataRepository {
  const threads = [...(seed.threads ?? [])];
  const replies = [...(seed.replies ?? [])];
  const comments = [...(seed.comments ?? [])];
  return {
    name: 'memory',
    forum: {
      async listThreads(opts = {}) {
        let list = threads.filter((t) => !opts.category || t.category === opts.category).sort(byDateDesc);
        if (opts.limit) list = list.slice(0, opts.limit);
        return list;
      },
      async getThread(id) {
        return threads.find((t) => t.id === id) ?? null;
      },
      async listReplies(threadId) {
        return replies.filter((r) => r.threadId === threadId).sort(byDateAsc);
      },
      async replyCounts() {
        const m: Record<string, number> = {};
        for (const r of replies) m[r.threadId] = (m[r.threadId] ?? 0) + 1;
        return m;
      },
    },
    comments: {
      async list(pageKey) {
        return comments.filter((c) => c.pageKey === pageKey).sort(byDateAsc);
      },
    },
  };
}
