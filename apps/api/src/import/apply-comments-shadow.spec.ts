import { ImportService } from './import.service';

/**
 * Full-thread comment import: shadow authors, deferred parent linkage, reconciliation.
 */
describe('ImportService.applyComments — shadow users + parent reconciliation', () => {
  function makeService(opts: { existingComments?: any[]; users?: Map<string, any> }) {
    const createdUsers: any[] = [];
    const commentCreates: any[] = [];
    const commentUpdates: { where: any; data: any }[] = [];
    let comments = [...(opts.existingComments ?? [])];
    const prisma: any = {
      comment: {
        findMany: jest.fn(async (args: any) => {
          const where = args?.where ?? {};
          if (where.parentSourceKey != null) {
            return comments
              .filter((c) => c.parentSourceKey === where.parentSourceKey && c.parentId == null)
              .map((c) => ({ id: c.id }));
          }
          return comments.filter((c) => {
            if (where.sourceKey?.in && !where.sourceKey.in.includes(c.sourceKey)) return false;
            if (where.userId?.in && !where.userId.in.includes(c.userId)) return false;
            if (where.source && c.source !== where.source) return false;
            return true;
          });
        }),
        update: jest.fn(async (args: any) => {
          commentUpdates.push(args);
          const c = comments.find((x) => x.id === args.where.id);
          if (c && args.data.repliesCount?.increment) {
            c.repliesCount = (c.repliesCount ?? 0) + args.data.repliesCount.increment;
          }
          return c;
        }),
        updateMany: jest.fn(async (args: any) => {
          for (const c of comments) {
            if (args.where.id?.in?.includes(c.id)) Object.assign(c, args.data);
          }
          return { count: 1 };
        }),
      },
      user: {
        findUnique: jest.fn(async (args: any) => {
          const email = args.where.email;
          return opts.users?.get(email) ?? createdUsers.find((u) => u.email === email) ?? null;
        }),
        create: jest.fn(async (args: any) => {
          const u = { id: `shadow-${createdUsers.length + 1}`, ...args.data };
          createdUsers.push(u);
          return u;
        }),
      },
      import: {
        findFirst: jest.fn(async () => ({ id: 'imp1', userId: 'u1' })),
        update: jest.fn(async () => ({})),
      },
      importItem: { updateMany: jest.fn(async () => ({})) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const service = new ImportService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { importFromUrl: jest.fn() } as any,
      {} as any,
    );
    (service as any).chunkedCreateMany = jest.fn(async (_tx: any, model: string, rows: any[]) => {
      if (model === 'comment') {
        commentCreates.push(...rows);
        for (const r of rows) comments.push({ ...r, repliesCount: 0 });
      }
    });
    return { service, prisma, createdUsers, commentCreates, commentUpdates, comments };
  }

  const replyItem = (parentKey: string) => ({
    id: 'it-reply',
    rowNumber: 2,
    sourceEntityType: 'MOVIE_COMMENT',
    status: 'MATCHED',
    matchedMediaId: 'm1',
    normalizedData: {
      text: 'reply text',
      sourceKey: 'tvtime|reply-1',
      sourceCommentId: 'reply-1',
      sourceAuthorId: 'ext-999',
      authorIsOwner: false,
      isReply: true,
      parentSourceCommentId: parentKey,
      spoiler: false,
      spoilerCount: null,
    },
  });

  const parentItem = {
    id: 'it-parent',
    rowNumber: 1,
    sourceEntityType: 'MOVIE_COMMENT',
    status: 'MATCHED',
    matchedMediaId: 'm1',
    normalizedData: {
      text: 'parent text',
      sourceKey: 'tvtime|parent-1',
      sourceCommentId: 'parent-1',
      sourceAuthorId: 'ext-999',
      authorIsOwner: false,
      isReply: false,
      parentSourceCommentId: null,
      spoiler: false,
      spoilerCount: null,
    },
  };

  it('creates a deterministic shadow user for third-party authors and reuses it', async () => {
    const { service, createdUsers, commentCreates } = makeService({});

    await (service as any).applyComments('u1', 'imp1', [parentItem], 'TVTIME');

    expect(createdUsers).toHaveLength(1);
    expect(createdUsers[0].email).toBe('shadow+tvtime-ext-999@shadow.local');
    expect(createdUsers[0].isShadow).toBe(true);
    expect(createdUsers[0].username).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+\d+$/);
    // The comment belongs to the shadow, not the importing user.
    expect(commentCreates[0].userId).toBe(createdUsers[0].id);
    expect(commentCreates[0].userId).not.toBe('u1');

    // Re-apply: no second shadow account, and the comment is deduped.
    const res2 = await (service as any).applyComments('u1', 'imp1', [parentItem], 'TVTIME');
    expect(createdUsers).toHaveLength(1);
    expect(res2.created).toBe(0);
  });

  it('links a stray reply when its parent arrives in a later import', async () => {
    const { service, comments } = makeService({});

    // Import 1: only the reply (parent unknown) → stored as a stray.
    await (service as any).applyComments('u1', 'imp1', [replyItem('parent-1')], 'TVTIME');
    const stray = comments.find((c) => c.sourceKey === 'tvtime|reply-1');
    expect(stray.parentId).toBeNull();
    expect(stray.parentSourceKey).toBe('tvtime|parent-1');

    // Import 2: the parent arrives (another user's archive, same shadow author).
    await (service as any).applyComments('u2', 'imp2', [parentItem], 'TVTIME');
    const parent = comments.find((c) => c.sourceKey === 'tvtime|parent-1');
    const linked = comments.find((c) => c.sourceKey === 'tvtime|reply-1');
    expect(linked.parentId).toBe(parent.id);
    expect(linked.parentSourceKey).toBe('tvtime|parent-1'); // identity kept
    expect(linked.depth).toBe(1);
    expect(linked.rootId).toBe(parent.id);
    expect(parent.repliesCount).toBe(1);
  });

  it('resolves in-batch parents in order (reply rows get parentId directly)', async () => {
    const { service, commentCreates } = makeService({});
    // Reply first in the array — the pass loop must still link it to the later parent.
    await (service as any).applyComments(
      'u1',
      'imp1',
      [replyItem('parent-1'), parentItem],
      'TVTIME',
    );
    const parent = commentCreates.find((c) => c.sourceKey === 'tvtime|parent-1');
    const reply = commentCreates.find((c) => c.sourceKey === 'tvtime|reply-1');
    expect(reply.parentId).toBe(parent.id);
    expect(reply.depth).toBe(1);
    expect(reply.parentSourceKey).toBeNull();
  });
});
