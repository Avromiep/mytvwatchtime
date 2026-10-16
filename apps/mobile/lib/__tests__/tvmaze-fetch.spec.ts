import { tvmazeGet } from '../tvmaze-fetch';

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe('tvmazeGet', () => {
  it('returns notFound only on HTTP 404', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 404, ok: false }) as any;
    expect(await tvmazeGet('u')).toEqual({ status: 'notFound' });
  });

  it('returns error on a 500 (and never treats it as not-found)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 500, ok: false }) as any;
    expect(await tvmazeGet('u')).toEqual({ status: 'error' });
  });

  it('returns error on a network failure', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as any;
    expect(await tvmazeGet('u')).toEqual({ status: 'error' });
  });

  it('retries a 429 (Retry-After) then succeeds', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ status: 429, ok: false, headers: { get: () => '0' } })
      .mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ id: 1 }) });
    global.fetch = fetchMock as any;
    expect(await tvmazeGet('u')).toEqual({ status: 'ok', data: { id: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up with error after 3 retries on persistent 429', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ status: 429, ok: false, headers: { get: () => '0' } });
    global.fetch = fetchMock as any;
    expect(await tvmazeGet('u')).toEqual({ status: 'error' });
    expect(fetchMock).toHaveBeenCalledTimes(4); // initial + 3 retries
  });
});
