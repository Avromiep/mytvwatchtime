import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Queue, Worker } from 'bullmq';
import { randomUUID } from 'crypto';
import { RedisService } from '../common/redis/redis.service';
import { DiscoveryService } from './discovery.service';

const QUEUE_NAME = 'personalization-warm';
const GATE_PREFIX = 'personalization:warm-gate';
const GATE_TTL_SECONDS = 30;
const WARM_DELAY_MS = 1500;

/**
 * Coalesces a burst of library events into one delayed recommendation rebuild.
 * The worker releases the gate before computing, so a change that arrives during
 * the rebuild schedules a trailing rebuild instead of being lost.
 */
@Injectable()
export class PersonalizationWarmProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PersonalizationWarmProcessor.name);
  private queue!: Queue;
  private worker!: Worker;

  constructor(
    private readonly redis: RedisService,
    private readonly discovery: DiscoveryService,
  ) {}

  onModuleInit() {
    const connection = this.redis.client as any;
    this.queue = new Queue(QUEUE_NAME, { connection });
    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        const { userId, generation } = job.data as { userId: string; generation: string };
        const gateKey = `${GATE_PREFIX}:${userId}`;
        const owner = await this.redis.client.get(gateKey);
        if (owner && owner !== generation) return;
        if (owner === generation) {
          await this.redis.client.eval(
            "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
            1,
            gateKey,
            generation,
          );
        }
        await this.discovery.warmPersonalizedRecommendations(userId);
      },
      { connection, concurrency: 2 },
    );
    this.worker.on('failed', (job, error) =>
      this.logger.error(`Personalization warm job ${job?.id} failed: ${error.message}`),
    );
  }

  async onModuleDestroy() {
    await Promise.all([this.worker?.close(), this.queue?.close()]);
  }

  @OnEvent('watch.episode', { async: true })
  @OnEvent('unwatch.episode', { async: true })
  @OnEvent('watch.movie', { async: true })
  @OnEvent('unwatch.movie', { async: true })
  @OnEvent('watchlist.added', { async: true })
  @OnEvent('watchlist.removed', { async: true })
  @OnEvent('favorite.added', { async: true })
  @OnEvent('favorite.removed', { async: true })
  @OnEvent('import.applied', { async: true })
  async requestWarm(payload: { userId?: string }) {
    if (!payload.userId) return;
    const generation = randomUUID();
    const gateKey = `${GATE_PREFIX}:${payload.userId}`;
    const acquired = await this.redis.client.set(gateKey, generation, 'EX', GATE_TTL_SECONDS, 'NX');
    if (acquired !== 'OK') return;
    try {
      await this.queue.add(
        'warm',
        { userId: payload.userId, generation },
        {
          jobId: `personalization-warm-${generation}`,
          delay: WARM_DELAY_MS,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
    } catch (error) {
      await this.redis.client.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
        1,
        gateKey,
        generation,
      );
      throw error;
    }
  }
}
