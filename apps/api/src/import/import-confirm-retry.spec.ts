import { ImportService } from './import.service';

describe('ImportService.confirm retry', () => {
  it('allows a failed section-idempotent import to be confirmed again', async () => {
    const prisma: any = {
      import: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'imp1',
          userId: 'u1',
          status: 'FAILED',
          processedAt: new Date('2026-08-01T12:00:00.000Z'),
          format: 'tvtime',
          ownerExternalId: null,
          storageKey: 'already-cleaned',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      importItem: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const storage = { delete: jest.fn().mockResolvedValue(undefined) };
    const events = { emit: jest.fn() };
    const service = new ImportService(
      prisma,
      storage as any,
      {} as any,
      events as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    (service as any).claimShadowAccount = jest.fn().mockResolvedValue(undefined);
    (service as any).applyBatch = jest.fn().mockResolvedValue({ created: 2, skipped: 1 });
    (service as any).rebuildShowStatuses = jest.fn().mockResolvedValue(undefined);

    await expect(service.confirm('u1', 'imp1')).resolves.toEqual({
      importId: 'imp1',
      created: 2,
      skipped: 1,
    });
    expect(prisma.import.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'imp1' },
      data: { status: 'IMPORTING', progress: 0 },
    });
    expect(prisma.import.update).toHaveBeenLastCalledWith({
      where: { id: 'imp1' },
      data: {
        status: 'COMPLETED',
        completedAt: expect.any(Date),
        progress: 100,
      },
    });
  });

  it('rejects a FAILED import whose archive processing never completed', async () => {
    const prisma: any = {
      import: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'imp1',
          userId: 'u1',
          status: 'FAILED',
          processedAt: null,
        }),
        update: jest.fn(),
      },
    };
    const service = new ImportService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(service.confirm('u1', 'imp1')).rejects.toThrow(
      'Import cannot be confirmed (status=FAILED)',
    );
    expect(prisma.import.update).not.toHaveBeenCalled();
  });
});
