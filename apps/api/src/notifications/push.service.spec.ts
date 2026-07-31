import { ConfigService } from '@nestjs/config';
import { PushService, stringifyValues } from './push.service';

const EXPO_DEVICE = { id: 'd1', token: 'ExponentPushToken[abc]', platform: 'ANDROID', pushP256dh: null, pushAuth: null };
const FCM_DEVICE = { id: 'd2', token: 'native-fcm-token-xyz', platform: 'ANDROID', pushP256dh: null, pushAuth: null };

function makeService(opts: { expoToken?: string; fcm?: { sendEachForMulticast: jest.Mock } }) {
  const prisma = { device: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } };
  const config = { get: jest.fn((key: string) => (key === 'push.expoAccessToken' ? opts.expoToken : undefined)) };
  const svc = new PushService(prisma as never, config as unknown as ConfigService);
  if (opts.fcm) (svc as unknown as { fcm: unknown }).fcm = opts.fcm;
  return { svc, prisma };
}

function mockFetchSequence(...payloads: unknown[]) {
  const fetchMock = jest.fn();
  for (const body of payloads) {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => body });
  }
  (global as { fetch: unknown }).fetch = fetchMock;
  return fetchMock;
}

describe('PushService.sendToDevices token routing', () => {
  const msg = { title: 'T', body: 'B', data: { category: 'ANNOUNCEMENT' } };
  const call = (svc: PushService, devices: (typeof EXPO_DEVICE)[]) => svc.sendToDevices(devices, msg);

  afterEach(() => jest.restoreAllMocks());

  it('sends Expo tokens via the Expo API even when FCM is configured', async () => {
    const fcm = { sendEachForMulticast: jest.fn().mockResolvedValue({ successCount: 1, failureCount: 0, responses: [{ success: true }] }) };
    const { svc } = makeService({ expoToken: 'tok', fcm });
    const fetchMock = mockFetchSequence({ data: [{ status: 'ok', id: 'r1' }] }, { data: { r1: { status: 'ok' } } });

    const res = await call(svc, [EXPO_DEVICE, FCM_DEVICE]);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://exp.host/--/api/v2/push/send',
      expect.objectContaining({
        body: expect.stringContaining('ExponentPushToken[abc]'),
        headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
      }),
    );
    expect(fcm.sendEachForMulticast).toHaveBeenCalledWith(expect.objectContaining({ tokens: ['native-fcm-token-xyz'] }));
    expect(res).toEqual({ sent: 2, failed: 0 });
  });

  it('sends Expo tokens without an access token when none is configured', async () => {
    const { svc } = makeService({});
    const fetchMock = mockFetchSequence({ data: [{ status: 'ok' }] });

    const res = await call(svc, [EXPO_DEVICE]);

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBeUndefined();
    expect(res).toEqual({ sent: 1, failed: 0 });
  });

  it('deactivates devices Expo reports as DeviceNotRegistered', async () => {
    const { svc, prisma } = makeService({});
    mockFetchSequence(
      { data: [{ status: 'ok', id: 'r1' }] },
      { data: { r1: { status: 'error', details: { error: 'DeviceNotRegistered' } } } },
    );

    await call(svc, [EXPO_DEVICE]);

    expect(prisma.device.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['d1'] } },
      data: { active: false },
    });
  });

  it('counts FCM tokens as failed when Firebase is not configured', async () => {
    const { svc } = makeService({});

    const res = await call(svc, [FCM_DEVICE]);

    expect(res).toEqual({ sent: 0, failed: 1 });
  });
});

// FCM rejects any data map containing non-string values. Broadcasts with no action
// carry undefined actionType/actionTarget/actionParams — one undefined entry used
// to poison the whole multicast (client-side throw, every mobile token failed).
describe('stringifyValues (FCM data sanitization)', () => {
  it('drops null and undefined values', () => {
    expect(stringifyValues({ a: undefined, b: null, c: 'x' })).toEqual({ c: 'x' });
  });

  it('keeps strings as-is and JSON-stringifies non-strings', () => {
    expect(stringifyValues({ s: 'v', n: 3, o: { k: 1 } })).toEqual({ s: 'v', n: '3', o: '{"k":1}' });
  });

  it('sanitizes a broadcast payload without action to strings only', () => {
    const out = stringifyValues({
      category: 'ANNOUNCEMENT',
      actionType: undefined,
      actionTarget: undefined,
      actionParams: undefined,
      broadcastId: 'bc-1',
    });
    expect(out).toEqual({ category: 'ANNOUNCEMENT', broadcastId: 'bc-1' });
    for (const v of Object.values(out)) expect(typeof v).toBe('string');
  });
});
