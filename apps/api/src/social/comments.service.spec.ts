import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CommentThreadType } from '@prisma/client';
import { CommentsService, MAX_COMMENT_DEPTH } from './comments.service';

function makeComment(over: Record<string, any> = {}) {
  return {
    id: 'c1',
    parentId: null,
    depth: 0,
    rootId: null,
    threadType: 'SHOW',
    threadId: 't1',
    userId: 'u1',
    body: '',
    imageUrl: null,
    gifUrl: null,
    likesCount: 0,
    repliesCount: 0,
    deletedByUser: false,
    editedAt: null,
    createdAt: new Date(),
    user: { id: 'u1', username: 'alice', profile: null, createdAt: new Date('2024-01-01') },
    image: null,
    ...over,
  };
}

function mockPrisma(commentRow: any = makeComment()) {
  return {
    block: { findMany: jest.fn().mockResolvedValue([]) },
    comment: {
      findUnique: jest.fn().mockResolvedValue(commentRow),
      findMany: jest.fn().mockResolvedValue([commentRow]),
      count: jest.fn().mockResolvedValue(1),
      groupBy: jest.fn().mockResolvedValue([]),
      create: jest.fn(async (args: any) => ({
        ...commentRow,
        ...args.data,
        gifUrl: args.data.gifUrl ?? null,
      })),
      update: jest.fn(async (args: any) => ({ ...commentRow, ...args.data })),
    },
    commentImage: { findUnique: jest.fn().mockResolvedValue(null) },
    commentLike: { findMany: jest.fn().mockResolvedValue([]) },
    follow: { count: jest.fn().mockResolvedValue(0), groupBy: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
}

function mockCommentImages() {
  return { remove: jest.fn().mockResolvedValue({ ok: true }) };
}

function makeService(commentRow: any = makeComment()) {
  const prisma: any = mockPrisma(commentRow);
  const events: any = { emit: jest.fn() };
  const notifications: any = { createForUser: jest.fn().mockResolvedValue(undefined) };
  const commentImages: any = mockCommentImages();
  const service = new CommentsService(prisma, events, notifications, commentImages);
  return { service, prisma, events, notifications, commentImages };
}

const base = { threadType: CommentThreadType.SHOW, threadId: 't1' };

describe('CommentsService.create — GIF support', () => {
  it('creates a text-only comment', async () => {
    const { service, prisma } = makeService();
    const res = await service.create('u1', { ...base, body: 'hello' } as any);
    expect(prisma.comment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ body: 'hello', gifUrl: undefined }),
      }),
    );
    expect(res.gifUrl).toBeNull();
  });

  it('creates a GIF-only comment with empty body', async () => {
    const { service, prisma } = makeService();
    const res = await service.create('u1', {
      ...base,
      body: '',
      gifUrl: 'https://media.giphy.com/media/abc/giphy.gif',
    } as any);
    expect(prisma.comment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          body: '',
          gifUrl: 'https://media.giphy.com/media/abc/giphy.gif',
        }),
      }),
    );
    expect(res.body).toBe('');
  });

  it('creates a text + GIF comment', async () => {
    const { service } = makeService();
    await service.create('u1', {
      ...base,
      body: 'nice',
      gifUrl: 'https://media1.giphy.com/media/abc/200.gif',
    } as any);
  });

  it('rejects empty body with no attachment', async () => {
    const { service } = makeService();
    await expect(service.create('u1', { ...base, body: '   ' } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an HTTP gif URL', async () => {
    const { service } = makeService();
    await expect(
      service.create('u1', { ...base, body: '', gifUrl: 'http://media.giphy.com/g.gif' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-GIPHY gif URL', async () => {
    const { service } = makeService();
    await expect(
      service.create('u1', { ...base, body: '', gifUrl: 'https://example.com/x.gif' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a malformed gif URL', async () => {
    const { service } = makeService();
    await expect(
      service.create('u1', { ...base, body: '', gifUrl: 'not-a-url' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects both an image and a GIF', async () => {
    const { service } = makeService();
    await expect(
      service.create('u1', {
        ...base,
        body: 'x',
        imageUrl: 'https://x',
        gifUrl: 'https://media.giphy.com/media/abc/giphy.gif',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('preserves null gifUrl for legacy rows in list/replies', async () => {
    const { service } = makeService(makeComment({ gifUrl: null }));
    const list = await service.list('u1', { threadType: 'SHOW', threadId: 't1' } as any);
    expect(list.items[0].gifUrl).toBeNull();
    const replies = await service.replies('u1', 'c1', {} as any);
    expect(replies.items[0].gifUrl).toBeNull();
  });

  it('returns gifUrl when present in list/replies', async () => {
    const { service } = makeService(
      makeComment({ gifUrl: 'https://media.giphy.com/media/abc/giphy.gif' }),
    );
    const list = await service.list('u1', { threadType: 'SHOW', threadId: 't1' } as any);
    expect(list.items[0].gifUrl).toBe('https://media.giphy.com/media/abc/giphy.gif');
    const replies = await service.replies('u1', 'c1', {} as any);
    expect(replies.items[0].gifUrl).toBe('https://media.giphy.com/media/abc/giphy.gif');
  });

  it('reply with missing parent throws NotFound', async () => {
    const prisma: any = mockPrisma(null);
    const events: any = { emit: jest.fn() };
    const notifications: any = { createForUser: jest.fn().mockResolvedValue(undefined) };
    const commentImages: any = mockCommentImages();
    const service = new CommentsService(prisma, events, notifications, commentImages);
    await expect(
      service.create('u1', { ...base, body: 'hi', parentId: 'missing' } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects replying to a tombstone parent', async () => {
    const { service } = makeService(makeComment({ parentId: null, deletedByUser: true }));
    await expect(
      service.create('u1', { ...base, body: 'hi', parentId: 'c1' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CommentsService.create — nested threads', () => {
  it('reply to a top-level comment gets depth 1 and rootId = parent id', async () => {
    const parent = makeComment({ id: 'p1', parentId: null, depth: 0, rootId: null });
    const { service, prisma } = makeService(parent);
    await service.create('u2', { ...base, body: 'hi', parentId: 'p1' } as any);
    expect(prisma.comment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ parentId: 'p1', depth: 1, rootId: 'p1' }),
      }),
    );
  });

  it('reply to a reply nests deeper and keeps the original root', async () => {
    const parent = makeComment({ id: 'p2', parentId: 'p1', depth: 1, rootId: 'p1' });
    const { service, prisma } = makeService(parent);
    await service.create('u2', { ...base, body: 'hi', parentId: 'p2' } as any);
    expect(prisma.comment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ parentId: 'p2', depth: 2, rootId: 'p1' }),
      }),
    );
  });

  it('rejects a reply whose parent lives in another thread', async () => {
    const parent = makeComment({ id: 'p1', threadId: 'other-thread' });
    const { service } = makeService(parent);
    await expect(
      service.create('u2', { ...base, body: 'hi', parentId: 'p1' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects replying past the max depth', async () => {
    const parent = makeComment({
      id: 'p1',
      parentId: 'root',
      depth: MAX_COMMENT_DEPTH,
      rootId: 'root',
    });
    const { service } = makeService(parent);
    await expect(
      service.create('u2', { ...base, body: 'hi', parentId: 'p1' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CommentsService.replies — depth=2', () => {
  it('depth=1 (default) does not fetch the second layer', async () => {
    const { service, prisma } = makeService();
    await service.replies('u1', 'c1', { page: 1, pageSize: 20 } as any);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('depth=2 appends preview children after direct children; total counts direct only', async () => {
    const direct = makeComment({ id: 'd1', parentId: 'c1', depth: 1, rootId: 'c1' });
    const child = makeComment({
      id: 'd1a',
      parentId: 'd1',
      depth: 2,
      rootId: 'c1',
      userId: 'u2',
      user: { id: 'u2', username: 'bob', profile: null, createdAt: new Date('2024-01-01') },
    });
    const prisma: any = mockPrisma(direct);
    prisma.comment.findMany = jest
      .fn()
      .mockResolvedValueOnce([direct]) // direct-children page
      .mockResolvedValueOnce([child]); // preview hydration
    prisma.comment.count = jest.fn().mockResolvedValue(5);
    prisma.$queryRaw = jest.fn().mockResolvedValue([{ id: 'd1a' }]);
    const events: any = { emit: jest.fn() };
    const notifications: any = { createForUser: jest.fn().mockResolvedValue(undefined) };
    const service = new CommentsService(prisma, events, notifications, mockCommentImages() as any);

    const res = await service.replies('u1', 'c1', { page: 1, pageSize: 20, depth: 2 } as any);
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(res.items.map((i: any) => i.id)).toEqual(['d1', 'd1a']);
    expect(res.items[0].depth).toBe(1);
    expect(res.items[1].depth).toBe(2);
    expect(res.total).toBe(5);
  });
});

describe('CommentsService.replies — pagination', () => {
  it('returns a paginated payload with hasMore', async () => {
    const { service } = makeService();
    const res = await service.replies('u1', 'c1', { page: 1, pageSize: 20 } as any);
    expect(res).toHaveProperty('items');
    expect(res).toHaveProperty('total');
    expect(res).toHaveProperty('hasMore');
    expect(Array.isArray(res.items)).toBe(true);
  });
});

describe('CommentsService.findOne', () => {
  it('returns the comment dto', async () => {
    const { service } = makeService(makeComment({ body: 'hi' }));
    const res = await service.findOne('u2', 'c1');
    expect(res.id).toBe('c1');
    expect(res.body).toBe('hi');
    expect(res.deletedByUser).toBe(false);
    expect(res.isEdited).toBe(false);
  });

  it('throws NotFound for hidden comments', async () => {
    const { service } = makeService(makeComment({ hidden: true }));
    await expect(service.findOne('u2', 'c1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CommentsService.update', () => {
  it('edits body and marks edited', async () => {
    const { service, prisma } = makeService(makeComment({ body: 'old', userId: 'u1' }));
    const res = await service.update('u1', 'c1', { body: 'new' });
    expect(prisma.comment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ body: 'new', editedAt: expect.any(Date) }),
      }),
    );
    expect(res.body).toBe('new');
    expect(res.isEdited).toBe(true);
  });

  it('forbids editing another user comment', async () => {
    const { service } = makeService(makeComment({ userId: 'u1' }));
    await expect(service.update('u2', 'c1', { body: 'x' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects clearing everything (no text/attachment)', async () => {
    const { service } = makeService(
      makeComment({ body: 'old', userId: 'u1', gifUrl: null, image: null }),
    );
    await expect(service.update('u1', 'c1', { body: '   ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('clears a GIF by passing null', async () => {
    const { service, prisma } = makeService(
      makeComment({
        body: 'keep',
        userId: 'u1',
        gifUrl: 'https://media.giphy.com/media/abc/giphy.gif',
      }),
    );
    await service.update('u1', 'c1', { gifUrl: null });
    expect(prisma.comment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ gifUrl: null }) }),
    );
  });

  it('rejects an invalid GIF on edit', async () => {
    const { service } = makeService(makeComment({ body: 'keep', userId: 'u1' }));
    await expect(
      service.update('u1', 'c1', { gifUrl: 'https://evil.com/x.gif' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('detaches the image when requested', async () => {
    const img = { id: 'img1', commentId: 'c1', userId: 'u1', status: 'ready' };
    const { service, commentImages, prisma } = makeService(
      makeComment({ body: 'keep', userId: 'u1', image: img }),
    );
    (prisma.commentImage.findUnique as jest.Mock).mockResolvedValue(img);
    await service.update('u1', 'c1', { detachImage: true });
    expect(commentImages.remove).toHaveBeenCalledWith('u1', 'img1');
  });

  it('forbids editing a tombstone', async () => {
    const { service } = makeService(makeComment({ userId: 'u1', deletedByUser: true }));
    await expect(service.update('u1', 'c1', { body: 'x' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('CommentsService.softDelete', () => {
  it('sets deletedByUser tombstone', async () => {
    const { service, prisma } = makeService(makeComment({ userId: 'u1', body: 'gone' }));
    const res = await service.softDelete('u1', 'c1');
    expect(res.deleted).toBe(true);
    expect(prisma.comment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deletedByUser: true }) }),
    );
  });

  it('forbids deleting another user comment', async () => {
    const { service } = makeService(makeComment({ userId: 'u1' }));
    await expect(service.softDelete('u2', 'c1')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('CommentsService tombstone mapping', () => {
  it('hides body/image/gif on a tombstone in list', async () => {
    const { service } = makeService(
      makeComment({
        deletedByUser: true,
        body: 'secret',
        gifUrl: 'https://media.giphy.com/media/abc/giphy.gif',
        image: { id: 'img1', status: 'ready', width: 10, height: 10, blurhash: 'abc' },
      }),
    );
    const list = await service.list('u1', { threadType: 'SHOW', threadId: 't1' } as any);
    expect(list.items[0].deletedByUser).toBe(true);
    expect(list.items[0].body).toBe('');
    expect(list.items[0].gifUrl).toBeNull();
    expect(list.items[0].image).toBeNull();
  });
});
