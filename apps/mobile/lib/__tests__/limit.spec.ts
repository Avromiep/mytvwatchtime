import { createDeduper, createLimiter } from '../limit';

describe('createLimiter', () => {
  it('runs tasks in FIFO order', async () => {
    const limiter = createLimiter(1);
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => limiter.run(async () => void order.push(n))));
    expect(order).toEqual([1, 2, 3]);
  });

  it('never runs more than n concurrently', async () => {
    const limiter = createLimiter(3);
    let running = 0;
    let maxRunning = 0;
    const task = () =>
      limiter.run(async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
      });
    await Promise.all(Array.from({ length: 12 }, task));
    expect(maxRunning).toBeLessThanOrEqual(3);
    expect(maxRunning).toBeGreaterThan(1);
  });

  it('respects the rolling-window start cap', async () => {
    const limiter = createLimiter(10, { rollingWindow: { maxStarts: 3, windowMs: 200 } });
    const t0 = Date.now();
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, () => limiter.run(async () => void starts.push(Date.now() - t0))),
    );
    starts.sort((a, b) => a - b);
    // No 4th start may fall within 200ms of the start 3 positions earlier.
    for (let i = 0; i + 3 < starts.length; i += 1) {
      expect(starts[i + 3] - starts[i]).toBeGreaterThanOrEqual(190);
    }
  });

  it('a throwing task frees its slot so the queue keeps draining', async () => {
    const limiter = createLimiter(1);
    const ran: string[] = [];
    const results = await Promise.allSettled([
      limiter.run(async () => {
        throw new Error('boom');
      }),
      limiter.run(async () => void ran.push('second')),
    ]);
    expect(results[0].status).toBe('rejected');
    expect(ran).toEqual(['second']);
  });
});

describe('createDeduper', () => {
  it('shares one promise for concurrent same-key calls', async () => {
    const dedupe = createDeduper<number>();
    let calls = 0;
    const fn = () => {
      calls += 1;
      return new Promise<number>((r) => setTimeout(() => r(42), 5));
    };
    const [a, b] = await Promise.all([dedupe('k', fn), dedupe('k', fn)]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(calls).toBe(1);
  });

  it('runs again after the first settles', async () => {
    const dedupe = createDeduper<number>();
    let calls = 0;
    const fn = async () => ++calls;
    await dedupe('k', fn);
    await dedupe('k', fn);
    expect(calls).toBe(2);
  });
});
