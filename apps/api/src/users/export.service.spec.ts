import * as fs from 'fs/promises';
import { ExportService } from './export.service';

jest.mock('fs/promises', () => ({
  unlink: jest.fn(),
  mkdir: jest.fn(),
  writeFile: jest.fn(),
  readFile: jest.fn(),
}));

describe('ExportService.deleteForUser', () => {
  it('removes export files and their download records', async () => {
    const prisma: any = {
      dataExport: {
        findMany: jest.fn(async () => [
          { id: 'export-1', fileName: 'one.json' },
          { id: 'export-2', fileName: 'missing.json' },
        ]),
        deleteMany: jest.fn(async () => ({ count: 2 })),
      },
    };
    (fs.unlink as jest.Mock)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const service = new ExportService(prisma, { get: jest.fn() } as any);

    await expect(service.deleteForUser('user-1')).resolves.toBe(2);
    expect(prisma.dataExport.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      select: { id: true, fileName: true },
    });
    expect(prisma.dataExport.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['export-1', 'export-2'] } },
    });
  });

  it('retains a record when filesystem deletion fails so expiry cleanup can retry', async () => {
    const prisma: any = {
      dataExport: {
        findMany: jest.fn(async () => [{ id: 'export-1', fileName: 'one.json' }]),
        deleteMany: jest.fn(),
      },
    };
    (fs.unlink as jest.Mock).mockRejectedValueOnce(new Error('disk unavailable'));
    const service = new ExportService(prisma, { get: jest.fn() } as any);

    await expect(service.deleteForUser('user-1')).resolves.toBe(0);
    expect(prisma.dataExport.deleteMany).not.toHaveBeenCalled();
  });
});
