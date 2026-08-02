import { DataDeletionService } from './data-deletion.service';

describe('DataDeletionService.confirmDeletion', () => {
  it('uses the shared ghost-preserving deletion flow and consumes the token', async () => {
    const request = {
      id: 'request-1',
      token: 'token-1',
      userId: 'user-1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const prisma: any = {
      deletionRequest: {
        findUnique: jest.fn(async () => request),
        update: jest.fn(async () => ({})),
      },
      user: {
        findUnique: jest.fn(async () => ({ username: 'person' })),
      },
    };
    const users: any = { deleteUserAccount: jest.fn(async () => ({ ghostUserId: 'ghost' })) };
    const service = new DataDeletionService(
      prisma,
      { enabled: false, send: jest.fn() } as any,
      { get: jest.fn() } as any,
      users,
    );

    await expect(service.confirmDeletion('token-1')).resolves.toEqual({
      deleted: true,
      username: 'person',
    });
    expect(users.deleteUserAccount).toHaveBeenCalledWith('user-1');
    expect(prisma.deletionRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { usedAt: expect.any(Date) },
    });
  });
});
