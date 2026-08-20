import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before the handler import so it binds the mocked SDKs.
// ---------------------------------------------------------------------------

const mockSqsSend = vi.fn();
const mockCreateCheckRun = vi.fn().mockResolvedValue(undefined);
const mockGetInstallationOctokit = vi.fn().mockResolvedValue({});

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send(cmd: unknown) { return mockSqsSend(cmd); }
  },
  ReceiveMessageCommand: class {
    input: unknown;
    readonly kind = 'receive';
    constructor(input: unknown) { this.input = input; }
  },
  SendMessageCommand: class {
    input: unknown;
    readonly kind = 'send';
    constructor(input: unknown) { this.input = input; }
  },
  DeleteMessageCommand: class {
    input: unknown;
    readonly kind = 'delete';
    constructor(input: unknown) { this.input = input; }
  },
}));

vi.mock('@mergewatch/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mergewatch/core')>();
  return { ...actual, createCheckRun: (...args: unknown[]) => mockCreateCheckRun(...args) };
});

vi.mock('../github-auth-ssm.js', () => ({
  SSMGitHubAuthProvider: class {
    getInstallationOctokit(id: number) { return mockGetInstallationOctokit(id); }
  },
  getWebhookSecret: () => Promise.resolve('test-secret'),
}));

process.env.REVIEW_QUEUE_URL = 'https://sqs.test/queue';
process.env.REVIEW_DLQ_URL = 'https://sqs.test/dlq';

const { handler, redriveDelaySeconds } = await import('./dlq-redrive.js');

function job(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    installationId: 99,
    owner: 'octo',
    repo: 'repo',
    prNumber: 7,
    headSha: 'abc123',
    mode: 'review',
    ...overrides,
  });
}

/** One ReceiveMessage batch, then an empty one to end the sweep loop. */
function receiveOnce(messages: unknown[]) {
  mockSqsSend.mockImplementation((cmd: { kind: string }) => {
    if (cmd.kind === 'receive') {
      const batch = messages.splice(0, messages.length);
      return Promise.resolve({ Messages: batch });
    }
    return Promise.resolve({});
  });
}

function sentCommands(kind: string) {
  return mockSqsSend.mock.calls.map((c) => c[0]).filter((c: { kind: string }) => c.kind === kind);
}

describe('redriveDelaySeconds', () => {
  it('grows with the generation', () => {
    expect(redriveDelaySeconds(1)).toBe(120);
    expect(redriveDelaySeconds(3)).toBe(360);
  });

  it('never exceeds the SQS 15-minute delay ceiling', () => {
    expect(redriveDelaySeconds(50)).toBe(900);
  });
});

describe('dlq-redrive handler (#398)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateCheckRun.mockResolvedValue(undefined);
    mockGetInstallationOctokit.mockResolvedValue({});
  });

  it('returns a dead-lettered job to the review queue and deletes it from the DLQ', async () => {
    receiveOnce([{ Body: job(), ReceiptHandle: 'rh-1' }]);

    const result = await handler();

    expect(result).toEqual({ redriven: 1, abandoned: 0 });
    const sends = sentCommands('send');
    expect(sends).toHaveLength(1);
    expect(sends[0].input.QueueUrl).toBe('https://sqs.test/queue');
    // First redrive: generation 1, its delay, and the original body intact.
    expect(sends[0].input.MessageAttributes.MergeWatchRedriveGeneration.StringValue).toBe('1');
    expect(sends[0].input.DelaySeconds).toBe(120);
    expect(JSON.parse(sends[0].input.MessageBody).prNumber).toBe(7);
    expect(sentCommands('delete')).toHaveLength(1);
  });

  it('increments the generation counter across redrives', async () => {
    receiveOnce([
      {
        Body: job(),
        ReceiptHandle: 'rh-1',
        MessageAttributes: { MergeWatchRedriveGeneration: { StringValue: '4' } },
      },
    ]);

    await handler();

    const sends = sentCommands('send');
    expect(sends[0].input.MessageAttributes.MergeWatchRedriveGeneration.StringValue).toBe('5');
    expect(sends[0].input.DelaySeconds).toBe(600);
  });

  it('abandons a job past the generation cap and completes its check run', async () => {
    receiveOnce([
      {
        Body: job(),
        ReceiptHandle: 'rh-1',
        MessageAttributes: { MergeWatchRedriveGeneration: { StringValue: '8' } },
      },
    ]);

    const result = await handler();

    expect(result).toEqual({ redriven: 0, abandoned: 1 });
    // Not re-sent — but the PR is not left with an in_progress check either.
    expect(sentCommands('send')).toHaveLength(0);
    expect(sentCommands('delete')).toHaveLength(1);
    expect(mockCreateCheckRun).toHaveBeenCalledTimes(1);
    const checkArgs = mockCreateCheckRun.mock.calls[0];
    expect(checkArgs[3]).toBe('abc123');
    expect(checkArgs[4].status).toBe('completed');
    expect(checkArgs[4].conclusion).toBe('failure');
  });

  it('leaves the message in the DLQ when the redrive send fails', async () => {
    const messages: unknown[] = [{ Body: job(), ReceiptHandle: 'rh-1' }];
    mockSqsSend.mockImplementation((cmd: { kind: string }) => {
      if (cmd.kind === 'receive') return Promise.resolve({ Messages: messages.splice(0, messages.length) });
      if (cmd.kind === 'send') return Promise.reject(new Error('sqs down'));
      return Promise.resolve({});
    });

    const result = await handler();

    expect(result).toEqual({ redriven: 0, abandoned: 0 });
    // Never delete a message we failed to re-send — it must survive for the
    // next sweep.
    expect(sentCommands('delete')).toHaveLength(0);
  });

  it('drops an unparseable message rather than cycling it forever', async () => {
    receiveOnce([{ Body: 'not json', ReceiptHandle: 'rh-1' }]);

    const result = await handler();

    expect(result).toEqual({ redriven: 0, abandoned: 0 });
    expect(sentCommands('send')).toHaveLength(0);
    expect(sentCommands('delete')).toHaveLength(1);
  });

  it('is a no-op on an empty DLQ', async () => {
    receiveOnce([]);

    const result = await handler();

    expect(result).toEqual({ redriven: 0, abandoned: 0 });
    expect(sentCommands('send')).toHaveLength(0);
    expect(sentCommands('delete')).toHaveLength(0);
  });
});
