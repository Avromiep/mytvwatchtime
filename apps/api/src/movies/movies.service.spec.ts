import { NotFoundException } from '@nestjs/common';
import { MoviesService } from './movies.service';

// Mock style modeled on media-metadata/metadata-backfill.service.spec.ts.
function model(methods: string[]) {
  const m: Record<string, jest.Mock> = {};
  for (const name of methods) m[name] = jest.fn();
  return m;
}

function mockPrisma(mediaRows: Record<string, { id: string; type: string } | null>) {
  const p = {
    mediaItem: model(['findUnique']),
    watchHistory: model(['updateMany']),
    comment: model(['updateMany']),
    $executeRaw: jest.fn(async () => 0),
    $transaction: jest.fn(async (arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(p))),
  } as any;
  p.mediaItem.findUnique.mockImplementation(({ where }: any) =>
    Promise.resolve(mediaRows[where.id] ?? null),
  );
  p.watchHistory.updateMany.mockResolvedValue({ count: 0 });
  p.comment.updateMany.mockResolvedValue({ count: 0 });
  return p;
}

function mockStats() {
  return { invalidate: jest.fn(async () => undefined) } as any;
}

function makeService(p: any, stats: any) {
  return new MoviesService(p, {} as any, {} as any, {} as any, {} as any, stats);
}

// Extract { sql, values } from tagged-template $executeRaw mock calls.
function rawCalls(p: any): { sql: string; values: any[] }[] {
  return p.$executeRaw.mock.calls.map((call: any[]) => ({
    sql: (Array.isArray(call[0]) ? call[0].join(' ') : String(call[0] ?? '')).replace(/\s+/g, ' '),
    values: call.slice(1),
  }));
}

const MOVIE_SRC = { id: 'src', type: 'MOVIE' };
const MOVIE_DST = { id: 'dst', type: 'MOVIE' };

describe('MoviesService.reassignUserMovie', () => {
  it('throws NotFoundException when the target row is missing', async () => {
    const p = mockPrisma({ src: MOVIE_SRC, dst: null });
    const svc = makeService(p, mockStats());
    await expect(svc.reassignUserMovie('u1', 'src', 'dst')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws NotFoundException when the target row is a SHOW', async () => {
    const p = mockPrisma({ src: MOVIE_SRC, dst: { id: 'dst', type: 'SHOW' } });
    const svc = makeService(p, mockStats());
    await expect(svc.reassignUserMovie('u1', 'src', 'dst')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(p.$executeRaw).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the source row is a SHOW', async () => {
    const p = mockPrisma({ src: { id: 'src', type: 'SHOW' }, dst: MOVIE_DST });
    const svc = makeService(p, mockStats());
    await expect(svc.reassignUserMovie('u1', 'src', 'dst')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('happy path: issues user-scoped moves for every table and invalidates stats', async () => {
    const p = mockPrisma({ src: MOVIE_SRC, dst: MOVIE_DST });
    p.watchHistory.updateMany.mockResolvedValue({ count: 3 });
    p.comment.updateMany.mockResolvedValue({ count: 2 });
    const stats = mockStats();
    const svc = makeService(p, stats);

    const summary = await svc.reassignUserMovie('u1', 'src', 'dst');

    const calls = rawCalls(p);
    // Every raw statement is scoped to this user (userId passed as a parameter value).
    for (const c of calls) expect(c.values).toContain('u1');

    const sqls = calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes('UPDATE user_movie_status t'))).toBe(true); // merge attempt
    expect(sqls.some((s) => s.includes('UPDATE user_movie_status SET media_id'))).toBe(true); // move
    expect(sqls.some((s) => s.includes('UPDATE ratings r SET media_id'))).toBe(true);
    expect(sqls.some((s) => s.includes('DELETE FROM ratings'))).toBe(true);
    expect(sqls.some((s) => s.includes('UPDATE reactions r SET media_id'))).toBe(true);
    expect(sqls.some((s) => s.includes('DELETE FROM reactions'))).toBe(true);
    expect(sqls.some((s) => s.includes('UPDATE watchlist_items w SET media_id'))).toBe(true);
    expect(sqls.some((s) => s.includes('DELETE FROM watchlist_items'))).toBe(true);
    expect(sqls.some((s) => s.includes('UPDATE favorites f SET media_id'))).toBe(true);
    expect(sqls.some((s) => s.includes('DELETE FROM favorites'))).toBe(true);
    expect(sqls.some((s) => s.includes('UPDATE custom_list_items i SET media_id'))).toBe(true);
    expect(sqls.some((s) => s.includes('DELETE FROM custom_list_items'))).toBe(true);
    // custom_list_items is scoped through the owning list.
    expect(sqls.some((s) => s.includes('custom_lists l WHERE l.id = i.list_id AND l.user_id'))).toBe(
      true,
    );
    // Unlike the admin merge: no external_ids / external_reviews, no media row delete.
    expect(sqls.some((s) => s.includes('external_ids'))).toBe(false);
    expect(sqls.some((s) => s.includes('external_reviews'))).toBe(false);
    expect(p.mediaItem.delete).toBeUndefined();

    // watch_history moved via updateMany, scoped to user + MOVIE type.
    expect(p.watchHistory.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', mediaId: 'src', mediaType: 'MOVIE' },
      data: { mediaId: 'dst' },
    });

    // comments: only this user's rows, both thread and attachment shapes.
    expect(p.comment.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', threadType: 'MOVIE', threadId: 'src' },
      data: { threadId: 'dst' },
    });
    expect(p.comment.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', mediaType: 'MOVIE', mediaId: 'src' },
      data: { mediaId: 'dst' },
    });

    expect(stats.invalidate).toHaveBeenCalledWith({ userId: 'u1' });
    expect(summary).toMatchObject({
      sourceId: 'src',
      targetMediaId: 'dst',
      watchHistory: { moved: 3 },
      comments: { threads: 2, attachments: 2 },
    });
    expect(p.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 60_000 });
  });

  it('conflict: existing target status row merges and deletes the source row instead of moving', async () => {
    const p = mockPrisma({ src: MOVIE_SRC, dst: MOVIE_DST });
    const stats = mockStats();
    const svc = makeService(p, stats);
    p.$executeRaw.mockImplementation((parts: any) => {
      const sql = (Array.isArray(parts) ? parts.join(' ') : String(parts ?? '')).replace(
        /\s+/g,
        ' ',
      );
      // Target status row exists → merge UPDATE affects one row.
      if (sql.includes('UPDATE user_movie_status t')) return Promise.resolve(1);
      return Promise.resolve(0);
    });

    const summary = await svc.reassignUserMovie('u1', 'src', 'dst');

    const sqls = rawCalls(p).map((c) => c.sql);
    expect(sqls.some((s) => s.includes('DELETE FROM user_movie_status'))).toBe(true);
    expect(sqls.some((s) => s.includes('UPDATE user_movie_status SET media_id'))).toBe(false);
    expect(summary.userMovieStatus).toEqual({ moved: 0, merged: 1 });
  });
});
