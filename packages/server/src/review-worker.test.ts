import { describe, it, expect, vi } from 'vitest';
import { startReviewWorker } from './review-worker.js';
import type { ClaimedReviewJob, IReviewJobQueue, ReviewJobPayload } from '@mergewatch/core';

const payload = { installationId: 1, owner: 'octo', repo: 'repo', prNumber: 7, mode: 'review' } as ReviewJobPayload;

function makeQueue(jobs: ClaimedReviewJob[][]): IReviewJobQueue & Record<string, any> {
  let call = 0;
  return {
    enqueue: vi.fn(),
    claim: vi.fn(async () => jobs[call++] ?? []),
    complete: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    kill: vi.fn(async () => {}),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('startReviewWorker (#355)', () => {
  it('processes a claimed job and completes it', async () => {
    const queue = makeQueue([[{ id: '1', payload, attempts: 1 }]]);
    const processJob = vi.fn(async () => {});
    const worker = startReviewWorker(queue, processJob, { pollIntervalMs: 60_000 });

    await worker.tick();
    await flush();

    expect(processJob).toHaveBeenCalledWith(payload);
    expect(queue.complete).toHaveBeenCalledWith('1');
    worker.stop();
  });

  it('retries a throttled job with exponential backoff', async () => {
    const queue = makeQueue([[{ id: '1', payload, attempts: 2 }]]);
    const processJob = vi.fn(async () => {
      throw Object.assign(new Error('Too many requests, please wait before trying again.'), { name: 'ThrottlingException' });
    });
    const worker = startReviewWorker(queue, processJob, { pollIntervalMs: 60_000, backoffBaseSeconds: 60 });

    await worker.tick();
    await flush();

    // attempt 2 → base × 2^(2-1) = 120s
    expect(queue.retry).toHaveBeenCalledWith('1', 120);
    expect(queue.complete).not.toHaveBeenCalled();
    expect(queue.kill).not.toHaveBeenCalled();
    worker.stop();
  });

  it('kills a job after maxAttempts throttles (DLQ analogue)', async () => {
    const queue = makeQueue([[{ id: '9', payload, attempts: 5 }]]);
    const processJob = vi.fn(async () => {
      throw Object.assign(new Error('x'), { status: 429 });
    });
    const worker = startReviewWorker(queue, processJob, { pollIntervalMs: 60_000, maxAttempts: 5 });

    await worker.tick();
    await flush();

    expect(queue.kill).toHaveBeenCalledWith('9');
    expect(queue.retry).not.toHaveBeenCalled();
    worker.stop();
  });

  it('completes (not retries) a job whose processor recorded a terminal failure', async () => {
    const queue = makeQueue([[{ id: '2', payload, attempts: 1 }]]);
    const processJob = vi.fn(async () => {
      throw Object.assign(new Error('model exploded'), { name: 'ValidationException' });
    });
    const worker = startReviewWorker(queue, processJob, { pollIntervalMs: 60_000 });

    await worker.tick();
    await flush();

    expect(queue.complete).toHaveBeenCalledWith('2');
    expect(queue.retry).not.toHaveBeenCalled();
    expect(queue.kill).not.toHaveBeenCalled();
    worker.stop();
  });

  it('logs (not swallows) a queue.retry failure and frees the slot', async () => {
    const queue = makeQueue([[{ id: '1', payload, attempts: 2 }], [{ id: '2', payload, attempts: 1 }]]);
    vi.mocked(queue.retry).mockRejectedValueOnce(new Error('connection reset'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Only the first job throttles; the second must still get its slot.
    const processJob = vi.fn(async () => {
      if (vi.mocked(queue.claim).mock.calls.length === 1) {
        throw Object.assign(new Error('x'), { status: 429 });
      }
    });
    const worker = startReviewWorker(queue, processJob, { pollIntervalMs: 60_000, concurrency: 1 });

    await worker.tick();
    await flush();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('queue.retry failed'), '1', expect.any(Error));

    await worker.tick(); // slot must be free again despite the retry failure
    await flush();
    expect(queue.complete).toHaveBeenCalledWith('2');
    errSpy.mockRestore();
    worker.stop();
  });

  it('logs (not swallows) a queue.kill failure', async () => {
    const queue = makeQueue([[{ id: '9', payload, attempts: 5 }]]);
    vi.mocked(queue.kill).mockRejectedValueOnce(new Error('connection reset'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const processJob = vi.fn(async () => {
      throw Object.assign(new Error('x'), { status: 429 });
    });
    const worker = startReviewWorker(queue, processJob, { pollIntervalMs: 60_000, maxAttempts: 5 });

    await worker.tick();
    await flush();

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('queue.kill failed'), '9', expect.any(Error));
    errSpy.mockRestore();
    worker.stop();
  });

  it('claims only the free concurrency slots', async () => {
    // Two slow jobs occupy both slots; the next tick must claim 0.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const queue = makeQueue([
      [{ id: '1', payload, attempts: 1 }, { id: '2', payload, attempts: 1 }],
      [],
    ]);
    const processJob = vi.fn(() => gate);
    const worker = startReviewWorker(queue, processJob, { pollIntervalMs: 60_000, concurrency: 2 });

    await worker.tick(); // claims 2, both in flight
    await worker.tick(); // no free slots — must not claim
    expect(queue.claim).toHaveBeenCalledTimes(1);

    release();
    await flush();
    await worker.tick(); // slots free again
    expect(queue.claim).toHaveBeenCalledTimes(2);
    worker.stop();
  });
});
