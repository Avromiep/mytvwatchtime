import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AdminService } from './admin.service';

function makeService(opts?: { actorRole?: string; targetRole?: string; shadow?: boolean }) {
  const prisma: any = {
    user: {
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id === 'admin') return { role: opts?.actorRole ?? 'ADMIN' };
        if (where.id === 'target') {
          return {
            id: 'target',
            username: 'person',
            email: 'person@example.com',
            role: opts?.targetRole ?? 'USER',
            isShadow: opts?.shadow ?? false,
          };
        }
        return null;
      }),
    },
    adminAuditLog: {
      create: jest.fn(async () => ({ id: 'audit-1' })),
      update: jest.fn(async () => ({})),
    },
  };
  const users: any = {
    deleteUserAccount: jest.fn(async () => ({
      ghostUserId: 'ghost',
      ratingsPreserved: 2,
    })),
  };
  const service = new AdminService(
    prisma,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    users,
  );
  return { service, prisma, users };
}

describe('AdminService.deleteUser', () => {
  it('keeps synthetic shadow identities out of the Admin user listing', async () => {
    const { service, prisma } = makeService();
    await service.getUsers({});
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isShadow: false } }),
    );
    expect(prisma.user.count).toHaveBeenCalledWith({ where: { isShadow: false } });
  });

  it('deletes a confirmed normal user through the shared privacy-preserving flow', async () => {
    const { service, prisma, users } = makeService();
    const result = await service.deleteUser('admin', 'target', 'person');

    expect(users.deleteUserAccount).toHaveBeenCalledWith('target');
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        adminId: 'admin',
        action: 'delete_user',
        targetType: 'user',
        targetId: 'target',
        metadata: { username: 'person', targetRole: 'USER', status: 'started' },
      },
    });
    expect(prisma.adminAuditLog.update).toHaveBeenCalledWith({
      where: { id: 'audit-1' },
      data: {
        metadata: {
          username: 'person',
          targetRole: 'USER',
          status: 'completed',
          preserved: { ghostUserId: 'ghost', ratingsPreserved: 2 },
        },
      },
    });
    expect(result).toEqual({
      ok: true,
      preserved: { ghostUserId: 'ghost', ratingsPreserved: 2 },
    });
  });

  it('requires the exact username and prevents self-deletion', async () => {
    const { service } = makeService();
    await expect(service.deleteUser('admin', 'target', 'wrong')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.deleteUser('admin', 'admin', 'anything')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('protects super-admin accounts and staff from ordinary admins', async () => {
    const superTarget = makeService({ targetRole: 'SUPER_ADMIN' }).service;
    await expect(superTarget.deleteUser('admin', 'target', 'person')).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    const staffTarget = makeService({ targetRole: 'MODERATOR' }).service;
    await expect(staffTarget.deleteUser('admin', 'target', 'person')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('retains a failed audit outcome when deletion does not complete', async () => {
    const { service, prisma, users } = makeService();
    users.deleteUserAccount.mockRejectedValueOnce(new Error('delete failed'));

    await expect(service.deleteUser('admin', 'target', 'person')).rejects.toThrow('delete failed');
    expect(prisma.adminAuditLog.update).toHaveBeenCalledWith({
      where: { id: 'audit-1' },
      data: {
        metadata: {
          username: 'person',
          targetRole: 'USER',
          status: 'failed',
          error: 'delete failed',
        },
      },
    });
  });
});
