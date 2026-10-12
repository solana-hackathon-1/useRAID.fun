import type { Prisma } from '@prisma/client';

export const ADMIN_PAGE = 25;
export type AdminListParams = {
  q?: string;
  creatorPage?: string;
  campaignPage?: string;
  postPage?: string;
};

export const adminPageNumber = (value: string | undefined) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100000) : 1;
};
const pageWindow = (value: string | undefined) => ({
  skip: (adminPageNumber(value) - 1) * ADMIN_PAGE,
  take: ADMIN_PAGE + 1,
});
const contains = (q: string) => ({ contains: q, mode: 'insensitive' as const });

// Every list reads one extra row so the page can tell whether a next page exists.
export function adminListArgs(params: AdminListParams, adminIds: string[]) {
  const q = (params.q || '').trim().slice(0, 100);
  return {
    q,
    users: {
      where: {
        AND: [
          { OR: [{ xId: null }, { xId: { notIn: adminIds } }] },
          ...(q ? [{ handle: contains(q) }] : []),
        ],
      },
      orderBy: [{ createdAt: 'desc' }],
      ...pageWindow(params.creatorPage),
    } satisfies Prisma.UserFindManyArgs,
    raids: {
      where: q
        ? { OR: [{ id: q }, { title: contains(q) }, { creator: { handle: contains(q) } }] }
        : {},
      orderBy: { createdAt: 'desc' },
      include: { creator: true },
      ...pageWindow(params.campaignPage),
    } satisfies Prisma.RaidFindManyArgs,
    posts: {
      where: q ? { OR: [{ id: q }, { raidId: q }, { text: contains(q) }] } : {},
      orderBy: { createdAt: 'desc' },
      ...pageWindow(params.postPage),
    } satisfies Prisma.PostFindManyArgs,
  };
}
