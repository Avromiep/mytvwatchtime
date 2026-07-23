// System "Deleted user" account: when a user deletes their account, their COMMENTS are
// reassigned to this single deterministic account instead of being cascade-deleted — threads
// (and other users' replies to them) survive, while everything personal (watch history,
// ratings, devices, sessions, credentials…) is removed by the normal user-delete cascade.
// Reassigning first also avoids the comments.parent_id NoAction FK failure that made account
// deletion fail outright for any user whose comments had replies.

import type { PrismaService } from '../../common/prisma/prisma.service';

export const DELETED_USER_EMAIL = 'deleted-user@system.local';
export const DELETED_USER_USERNAME = 'deleted-user';

/** Usernames that may never be registered or claimed (system identities). */
export const RESERVED_USERNAMES = new Set([DELETED_USER_USERNAME]);

/** Emails that may never be registered or authenticated (system identities). */
export const RESERVED_USER_EMAILS = new Set([DELETED_USER_EMAIL]);

/** True when a user row (or DTO source row) is the system deleted-user account. */
export function isDeletedUserAccount(u: {
  email?: string | null;
  username?: string | null;
}): boolean {
  return u?.email === DELETED_USER_EMAIL || u?.username === DELETED_USER_USERNAME;
}

type PrismaLike = Pick<PrismaService, 'user'>;

const DELETE_TRANSACTION_TIMEOUT_MS = 180_000;
const COUNTER_UPDATE_CHUNK_SIZE = 5_000;

/**
 * Get-or-create the system deleted-user account (shared by every deletion, race-safe on
 * the unique email/username — mirrors the shadow-user pattern in the import module).
 */
export async function getOrCreateDeletedUser(prisma: PrismaLike): Promise<string> {
  const existing = await prisma.user.findUnique({
    where: { email: DELETED_USER_EMAIL },
    select: { id: true },
  });
  if (existing) return existing.id;
  try {
    const created = await prisma.user.create({
      data: {
        email: DELETED_USER_EMAIL,
        username: DELETED_USER_USERNAME,
        passwordHash: null,
        role: 'USER',
        isShadow: false,
        profile: { create: { displayName: 'Deleted user' } },
      },
      select: { id: true },
    });
    return created.id;
  } catch (e: any) {
    if (e?.code === 'P2002') {
      const found = await prisma.user.findUnique({
        where: { email: DELETED_USER_EMAIL },
        select: { id: true },
      });
      if (found) return found.id;
    }
    throw e;
  }
}

/**
 * Anonymize-and-delete: move the user's comments to the deleted-user account, fix the
 * denormalized counters their cascade removes (their likes / spoiler reports on OTHER
 * comments), then delete the user row (everything else cascades). No-op when the user
 * is already gone (idempotent retries). Never logs comment content.
 */
export async function anonymizeAndDeleteUser(prisma: PrismaService, userId: string): Promise<void> {
  const exists = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!exists) return;
  const deletedId = await getOrCreateDeletedUser(prisma);

  // These reads can be large for active users. Keep them out of the interactive
  // transaction so the transaction budget is spent on the atomic write phase.
  const [liked, flagged] = await Promise.all([
    prisma.commentLike.findMany({
      where: { userId },
      select: { commentId: true },
    }),
    prisma.commentSpoilerReport.findMany({
      where: { userId },
      select: { commentId: true },
    }),
  ]);
  const likedCommentIds = [...new Set(liked.map((l: any) => l.commentId))];
  const flaggedCommentIds = [...new Set(flagged.map((f: any) => f.commentId))];

  const decrementCounter = async (
    tx: any,
    ids: string[],
    field: 'likesCount' | 'spoilerCount',
  ) => {
    for (let i = 0; i < ids.length; i += COUNTER_UPDATE_CHUNK_SIZE) {
      await tx.comment.updateMany({
        where: { id: { in: ids.slice(i, i + COUNTER_UPDATE_CHUNK_SIZE) } },
        data: { [field]: { decrement: 1 } },
      });
    }
    await tx.comment.updateMany({
      where: { [field]: { lt: 0 } },
      data: { [field]: 0 },
    });
  };

  // Raised budget: user.delete fires the whole cascade tree (history, statuses,
  // ratings, devices, sessions…), and heavy users can exceed Prisma's 60s default.
  await prisma.$transaction(
    async (tx: any) => {
      // Keep the comments; delete everything else via the user cascade.
      await tx.comment.updateMany({ where: { userId }, data: { userId: deletedId } });
      await tx.user.delete({ where: { id: userId } });
      if (likedCommentIds.length) {
        await decrementCounter(tx, likedCommentIds, 'likesCount');
      }
      if (flaggedCommentIds.length) {
        await decrementCounter(tx, flaggedCommentIds, 'spoilerCount');
      }
    },
    { timeout: DELETE_TRANSACTION_TIMEOUT_MS, maxWait: 10_000 },
  );
}
