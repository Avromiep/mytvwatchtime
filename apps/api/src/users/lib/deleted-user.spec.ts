import {
  anonymizeAndDeleteUser,
  getOrCreateDeletedUser,
  isDeletedUserAccount,
  DELETED_USER_EMAIL,
  DELETED_USER_USERNAME,
} from './deleted-user';

function makePrisma(opts: { existingDeletedUser?: boolean; userExists?: boolean } = {}) {
  const users: any[] = [];
  if (opts.existingDeletedUser) {
    users.push({ id: 'deleted-sys', email: DELETED_USER_EMAIL, username: DELETED_USER_USERNAME });
  }
  const calls = {
    commentUpdateMany: [] as any[],
    userCreate: [] as any[],
  };
  const prisma: any = {
    user: {
      findUnique: jest.fn(async (args: any) => {
        if (args.where.email === DELETED_USER_EMAIL) {
          return users.find((u) => u.email === DELETED_USER_EMAIL) ?? null;
        }
        if (args.where.id === 'u1') return opts.userExists === false ? null : { id: 'u1' };
        if (args.where.id === 'deleted-sys') return users[0] ?? null;
        return null;
      }),
      create: jest.fn(async (args: any) => {
        calls.userCreate.push(args);
        const u = { id: 'deleted-sys', ...args.data };
        users.push(u);
        return { id: u.id };
      }),
      delete: jest.fn(async () => ({})),
    },
    comment: {
      updateMany: jest.fn(async (args: any) => {
        calls.commentUpdateMany.push(args);
        return { count: 1 };
      }),
    },
    commentLike: {
      findMany: jest.fn(async () => [{ commentId: 'c-liked-1' }, { commentId: 'c-liked-2' }]),
    },
    commentSpoilerReport: {
      findMany: jest.fn(async () => [{ commentId: 'c-flagged-1' }]),
    },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  return { prisma, calls };
}

describe('deleted-user account', () => {
  it('identifies the system account by email or username', () => {
    expect(isDeletedUserAccount({ email: DELETED_USER_EMAIL })).toBe(true);
    expect(isDeletedUserAccount({ username: DELETED_USER_USERNAME })).toBe(true);
    expect(isDeletedUserAccount({ email: 'a@b.c', username: 'real' })).toBe(false);
  });

  it('creates the system account once and reuses it', async () => {
    const { prisma, calls } = makePrisma();
    const id1 = await getOrCreateDeletedUser(prisma);
    const id2 = await getOrCreateDeletedUser(prisma);
    expect(id1).toBe('deleted-sys');
    expect(id2).toBe('deleted-sys');
    expect(calls.userCreate).toHaveLength(1);
    expect(calls.userCreate[0].data.email).toBe(DELETED_USER_EMAIL);
    expect(calls.userCreate[0].data.username).toBe(DELETED_USER_USERNAME);
  });

  it('returns the existing system account without creating', async () => {
    const { prisma, calls } = makePrisma({ existingDeletedUser: true });
    expect(await getOrCreateDeletedUser(prisma)).toBe('deleted-sys');
    expect(calls.userCreate).toHaveLength(0);
  });
});

describe('anonymizeAndDeleteUser', () => {
  it('reassigns comments to the system account, deletes the user, fixes counters', async () => {
    const { prisma, calls } = makePrisma();
    await anonymizeAndDeleteUser(prisma, 'u1');

    // Comments survive under the system account.
    const reassign = calls.commentUpdateMany.find(
      (c) => c.where.userId === 'u1' && c.data.userId === 'deleted-sys',
    );
    expect(reassign).toBeDefined();
    // User row deleted (personal data cascades).
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'u1' } });
    // Denormalized counters decremented for the cascaded likes / spoiler reports.
    const likesDec = calls.commentUpdateMany.find(
      (c) => c.where.id?.in?.includes('c-liked-1') && c.data.likesCount?.decrement === 1,
    );
    const spoilerDec = calls.commentUpdateMany.find(
      (c) => c.where.id?.in?.includes('c-flagged-1') && c.data.spoilerCount?.decrement === 1,
    );
    expect(likesDec).toBeDefined();
    expect(spoilerDec).toBeDefined();
    // Negative counters clamped.
    expect(calls.commentUpdateMany.some((c) => c.where.likesCount?.lt === 0)).toBe(true);
    expect(calls.commentUpdateMany.some((c) => c.where.spoilerCount?.lt === 0)).toBe(true);
  });

  it('is a no-op when the user is already gone', async () => {
    const { prisma, calls } = makePrisma({ userExists: false });
    await anonymizeAndDeleteUser(prisma, 'u1');
    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(calls.commentUpdateMany).toHaveLength(0);
  });
});
