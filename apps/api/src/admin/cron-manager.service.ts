import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationScheduler } from '../notifications/notification.scheduler';
import { MetadataBackfillService } from '../media-metadata/metadata-backfill.service';
import { AdminService } from './admin.service';
import { CronExpression } from '@nestjs/schedule';

interface JobHandler {
  label: string;
  defaultSchedule: string;
  fn: () => Promise<unknown>;
}

const DEFAULTS: { name: string; label: string; schedule: string }[] = [
  {
    name: 'episode_notifications',
    label: 'Episode Notifications',
    schedule: CronExpression.EVERY_HOUR,
  },
  { name: 'watchlist_reminders', label: 'Watchlist Reminders', schedule: '0 22 * * *' },
  { name: 'tvmaze_airtimes', label: 'TVmaze Air Time Refresh', schedule: '0 7 * * *' },
  {
    name: 'push_dispatch',
    label: 'Push Notification Dispatch',
    schedule: CronExpression.EVERY_5_MINUTES,
  },
  { name: 'metadata_backfill', label: 'Metadata Backfill', schedule: '0 4 * * *' },
  { name: 'tmdb_changes', label: 'TMDB Changes Sync', schedule: '0 5 * * *' },
  { name: 'anime_tvdb_rehydrate', label: 'Anime TVDB Rehydration', schedule: '0 6 * * *' },
  {
    name: 'scheduled_hydrations',
    label: 'Scheduled Hydrations Sync',
    schedule: CronExpression.EVERY_HOUR,
  },
];

@Injectable()
export class CronManagerService implements OnModuleInit {
  private readonly logger = new Logger(CronManagerService.name);
  private handlers = new Map<string, JobHandler>();
  /** Registered dynamic per-row hydration jobs: rowId → `${schedule}|${timezone}`. */
  private hydrationJobs = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: SchedulerRegistry,
    private readonly notificationScheduler: NotificationScheduler,
    private readonly adminService: AdminService,
    private readonly metadataBackfill: MetadataBackfillService,
  ) {}

  async onModuleInit() {
    // Register handlers
    this.handlers.set('episode_notifications', {
      label: 'Episode Notifications',
      defaultSchedule: CronExpression.EVERY_HOUR,
      fn: () => this.notificationScheduler.scheduleEpisodeNotifications(),
    });
    this.handlers.set('watchlist_reminders', {
      label: 'Watchlist Reminders',
      defaultSchedule: '0 22 * * *',
      fn: () => this.notificationScheduler.watchlistReminders(),
    });
    this.handlers.set('tvmaze_airtimes', {
      label: 'TVmaze Air Time Refresh',
      defaultSchedule: '0 7 * * *',
      fn: () => this.notificationScheduler.refreshAirtimes(),
    });
    this.handlers.set('push_dispatch', {
      label: 'Push Notification Dispatch',
      defaultSchedule: CronExpression.EVERY_5_MINUTES,
      fn: async () => {
        /* handled by PushService cron directly */
      },
    });
    this.handlers.set('metadata_backfill', {
      label: 'Metadata Backfill',
      defaultSchedule: '0 4 * * *',
      fn: () => this.metadataBackfill.backfillBatch(),
    });
    this.handlers.set('tmdb_changes', {
      label: 'TMDB Changes Sync',
      defaultSchedule: '0 5 * * *',
      fn: () => this.metadataBackfill.syncTmdbChanges(),
    });
    this.handlers.set('anime_tvdb_rehydrate', {
      label: 'Anime TVDB Rehydration',
      defaultSchedule: '0 6 * * *',
      fn: () => this.metadataBackfill.rehydrateAnimeFromTvdb(),
    });
    this.handlers.set('scheduled_hydrations', {
      label: 'Scheduled Hydrations Sync',
      defaultSchedule: CronExpression.EVERY_HOUR,
      fn: () => this.syncHydrationSchedules(),
    });

    // Seed defaults
    for (const d of DEFAULTS) {
      await this.prisma.cronJob.upsert({
        where: { name: d.name },
        create: { name: d.name, label: d.label, schedule: d.schedule, enabled: true },
        update: { label: d.label },
      });
    }

    // Schedule all enabled jobs from DB
    const jobs = await this.prisma.cronJob.findMany();
    for (const job of jobs) {
      if (job.enabled) this.scheduleJob(job);
    }
    this.logger.log(`Loaded ${jobs.length} cron jobs from database`);

    // Dynamic per-row hydration schedules: sync now, then re-sync hourly (covers edits
    // made in the Auto Hydrations page without an API restart).
    await this.syncHydrationSchedules().catch((e) =>
      this.logger.warn(`hydration schedule sync failed: ${(e as Error).message}`),
    );
    setInterval(
      () =>
        this.syncHydrationSchedules().catch((e) =>
          this.logger.warn(`hydration schedule sync failed: ${(e as Error).message}`),
        ),
      60 * 60 * 1000,
    ).unref();
  }

  /**
   * Each enabled ScheduledHydration row gets its OWN node-cron job (schedule + timezone).
   * Replaces the old behavior where every enabled row fired unconditionally every hour.
   * Rows edited/added/disabled in the admin UI are picked up on the next sync.
   */
  async syncHydrationSchedules(): Promise<{ scheduled: number; removed: number }> {
    const rows = await this.prisma.scheduledHydration.findMany();
    const enabled = rows.filter((r) => r.enabled);
    let scheduled = 0;
    let removed = 0;

    const wanted = new Map(enabled.map((r) => [r.id, `${r.schedule}|${r.timezone ?? ''}`]));
    for (const row of enabled) {
      const key = `hydration_${row.id}`;
      const sig = wanted.get(row.id)!;
      if (this.hydrationJobs.get(row.id) === sig) continue; // unchanged
      try {
        if (this.scheduler.doesExist('cron', key)) this.scheduler.deleteCronJob(key);
      } catch {
        /* not registered yet */
      }
      const cron = require('node-cron');
      const task = cron.schedule(
        row.schedule,
        () =>
          this.executeHydrationRow(row.id).catch((e) =>
            this.logger.error(`Scheduled hydration ${row.label} failed: ${(e as Error).message}`),
          ),
        { scheduled: false, timezone: row.timezone ?? undefined },
      );
      this.scheduler.addCronJob(key, task as any);
      task.start();
      this.hydrationJobs.set(row.id, sig);
      scheduled++;
    }

    // Remove jobs for rows that were deleted or disabled.
    for (const rowId of [...this.hydrationJobs.keys()]) {
      if (!wanted.has(rowId)) {
        const key = `hydration_${rowId}`;
        try {
          this.scheduler.deleteCronJob(key);
        } catch {
          /* already gone */
        }
        this.hydrationJobs.delete(rowId);
        removed++;
      }
    }
    if (scheduled || removed)
      this.logger.log(`Hydration schedules synced: ${scheduled} scheduled, ${removed} removed`);
    return { scheduled, removed };
  }

  /** One dynamic scheduled-hydration run (reported on the /jobs page via HydrationJob). */
  private async executeHydrationRow(rowId: string): Promise<void> {
    const row = await this.prisma.scheduledHydration.findUnique({ where: { id: rowId } });
    if (!row || !row.enabled) return;
    const result = await this.adminService.triggerHydration('system', row.type, {
      pages: row.pages,
    });
    await this.prisma.scheduledHydration.update({
      where: { id: row.id },
      data: { lastRunAt: new Date(), lastJobId: result.jobId },
    });
    this.logger.log(`Scheduled hydration "${row.label}" triggered: ${result.totalItems} items`);
  }

  private scheduleJob(job: CronJob) {
    const handler = this.handlers.get(job.name);
    if (!handler) {
      this.logger.warn(`No handler for cron job: ${job.name}`);
      return;
    }

    try {
      // Delete existing if re-scheduling
      if (this.scheduler.doesExist('cron', job.name)) {
        this.scheduler.deleteCronJob(job.name);
      }
    } catch {
      /* doesn't exist yet */
    }

    const cron = require('node-cron');
    const task = cron.schedule(job.schedule, () => this.executeJob(job.name), {
      scheduled: false,
      // Per-job IANA timezone; undefined = server default.
      timezone: job.timezone ?? undefined,
    });
    this.scheduler.addCronJob(job.name, task as any);
    task.start();
    this.logger.debug(
      `Scheduled "${job.name}" with: ${job.schedule}${job.timezone ? ` (${job.timezone})` : ''}`,
    );
  }

  private async executeJob(name: string) {
    const handler = this.handlers.get(name);
    if (!handler) return;

    const job = await this.prisma.cronJob.findUnique({ where: { name } });
    if (!job || !job.enabled) return;

    const startedAt = new Date();
    this.logger.log(`Running cron job: ${job.label}`);

    try {
      const result = await handler.fn();
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      // Persist the handler's outcome summary (counts) with the run — powers the
      // "Report" column in the admin history view.
      const resultJson =
        result && typeof result === 'object'
          ? (JSON.parse(JSON.stringify(result).slice(0, 2000) || '{}') as any)
          : undefined;

      await this.prisma.cronJob.update({
        where: { name },
        data: {
          lastRunAt: startedAt,
          lastStatus: 'success',
          lastError: null,
          lastDurationMs: durationMs,
          runs: { increment: 1 },
        },
      });
      await this.prisma.cronJobRun.create({
        data: {
          jobId: job.id,
          status: 'success',
          result: resultJson,
          durationMs,
          startedAt,
          finishedAt,
        },
      });
    } catch (e) {
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      const error = (e as Error).message?.slice(0, 500);

      await this.prisma.cronJob.update({
        where: { name },
        data: {
          lastRunAt: startedAt,
          lastStatus: 'failed',
          lastError: error,
          lastDurationMs: durationMs,
          runs: { increment: 1 },
        },
      });
      await this.prisma.cronJobRun.create({
        data: { jobId: job.id, status: 'failed', error, durationMs, startedAt, finishedAt },
      });
      this.logger.error(`Cron job "${job.label}" failed: ${error}`);
    }
  }

  // ---------------- Admin API ----------------
  async getAll() {
    return this.prisma.cronJob.findMany({ orderBy: { name: 'asc' } });
  }

  async getHistory(name: string, page = 1, pageSize = 20) {
    const job = await this.prisma.cronJob.findUnique({ where: { name } });
    if (!job) return { items: [], total: 0 };
    const [items, total] = await Promise.all([
      this.prisma.cronJobRun.findMany({
        where: { jobId: job.id },
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.cronJobRun.count({ where: { jobId: job.id } }),
    ]);
    return { items, total, page, pageSize };
  }

  async update(
    adminId: string,
    name: string,
    data: { schedule?: string; enabled?: boolean; timezone?: string | null },
  ) {
    const job = await this.prisma.cronJob.update({ where: { name }, data });
    // Re-schedule or delete
    try {
      this.scheduler.deleteCronJob(name);
    } catch {}
    if (job.enabled) this.scheduleJob(job);
    this.logger.log(
      `Cron job "${name}" updated: schedule=${job.schedule} enabled=${job.enabled} tz=${job.timezone ?? 'server'}`,
    );
    return job;
  }

  async triggerNow(adminId: string, name: string) {
    await this.executeJob(name);
    return { ok: true };
  }
}
