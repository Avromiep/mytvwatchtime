import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { EmailService } from '../common/email.service';
import { anonymizeAndDeleteUser } from '../users/lib/deleted-user';

@Injectable()
export class DataDeletionService {
  private readonly logger = new Logger(DataDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  async requestDeletion(email: string): Promise<{ sent: boolean; link?: string }> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, username: true },
    });
    // Don't reveal whether the email exists — but still create a request for rate-limiting
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    await this.prisma.deletionRequest.create({
      data: { email, userId: user?.id ?? null, token, expiresAt },
    });

    const siteUrl = this.config.get<string>('site.url')!;
    const link = `${siteUrl}/delete-account?token=${token}`;

    if (user) {
      if (this.email.enabled) {
        const html = `
          <h2>Confirm Account Deletion</h2>
          <p>You requested to delete your TVWatchTime account (<strong>${user.username}</strong>).</p>
          <p>This will permanently remove your personal data: watch history, ratings, watchlists, devices, and profile. Your comments remain visible under an anonymized "Deleted user" identity.</p>
          <p><strong>This action cannot be undone.</strong></p>
          <p style="margin: 24px 0;">
            <a href="${link}" style="background:#FFD60A;color:#0F1115;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;">Confirm Deletion</a>
          </p>
          <p style="color:#666;font-size:13px;">This link expires in 24 hours. If you didn't request this, you can safely ignore this email.</p>
        `;
        await this.email.send(email, 'Confirm Your Account Deletion — TVWatchTime', html);
        return { sent: true };
      } else {
        this.logger.log(`SMTP not configured — deletion link for ${email}: ${link}`);
        return { sent: true };
      }
    }

    // Email doesn't exist — pretend we sent it (don't reveal account existence)
    return { sent: true };
  }

  async confirmDeletion(token: string): Promise<{ deleted: boolean; username?: string }> {
    const req = await this.prisma.deletionRequest.findUnique({ where: { token } });
    if (!req) throw new NotFoundException('Invalid or expired deletion link');
    if (req.usedAt) throw new BadRequestException('This deletion link has already been used');
    if (req.expiresAt < new Date()) throw new BadRequestException('This deletion link has expired');

    if (!req.userId) {
      await this.prisma.deletionRequest.update({
        where: { id: req.id },
        data: { usedAt: new Date() },
      });
      return { deleted: true };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: req.userId },
      select: { username: true },
    });
    if (!user) {
      await this.prisma.deletionRequest.update({
        where: { id: req.id },
        data: { usedAt: new Date() },
      });
      return { deleted: true };
    }

    // Anonymize-and-delete: comments move to the system "Deleted user" account (threads
    // survive, incl. other users' replies); everything personal cascades away.
    // Evict the JWT existence cache BEFORE the row delete so in-flight requests
    // re-check the DB instead of racing through on the stale positive entry.
    await this.redis.del(`auth:user:${req.userId}`);
    await anonymizeAndDeleteUser(this.prisma, req.userId);

    await this.prisma.deletionRequest.update({
      where: { id: req.id },
      data: { usedAt: new Date() },
    });

    this.logger.log(`User ${user.username} (${req.userId}) deleted all data via deletion request`);
    return { deleted: true, username: user.username };
  }
}
