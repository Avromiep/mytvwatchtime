import {
  airstampToET,
  airTimeLabel,
  easternOffsetMinutes,
  streamingDropET,
  tvmazeEpisodeTimeLabel,
} from '../airtime';

describe('easternOffsetMinutes', () => {
  it('is EDT (-240) in summer and EST (-300) in winter', () => {
    expect(easternOffsetMinutes(Date.parse('2026-07-01T12:00:00Z'))).toBe(-240);
    expect(easternOffsetMinutes(Date.parse('2026-01-15T12:00:00Z'))).toBe(-300);
  });

  it('switches at the DST boundaries in 2026 (Mar 8 / Nov 1)', () => {
    expect(easternOffsetMinutes(Date.parse('2026-03-08T06:59:00Z'))).toBe(-300);
    expect(easternOffsetMinutes(Date.parse('2026-03-08T07:00:00Z'))).toBe(-240);
    expect(easternOffsetMinutes(Date.parse('2026-11-01T05:59:00Z'))).toBe(-240);
    expect(easternOffsetMinutes(Date.parse('2026-11-01T06:00:00Z'))).toBe(-300);
  });

  it('switches at the DST boundaries in 2027 (Mar 14 / Nov 7)', () => {
    expect(easternOffsetMinutes(Date.parse('2027-03-14T06:59:00Z'))).toBe(-300);
    expect(easternOffsetMinutes(Date.parse('2027-03-14T07:00:00Z'))).toBe(-240);
    expect(easternOffsetMinutes(Date.parse('2027-11-07T05:59:00Z'))).toBe(-240);
    expect(easternOffsetMinutes(Date.parse('2027-11-07T06:00:00Z'))).toBe(-300);
  });
});

describe('airstampToET', () => {
  it('converts a tz-aware instant to 12-hour ET (EDT)', () => {
    expect(airstampToET('2026-09-09T02:00:00Z')).toBe('10:00 PM ET');
  });
  it('returns null for missing / invalid input', () => {
    expect(airstampToET(null)).toBeNull();
    expect(airstampToET('not-a-date')).toBeNull();
  });
});

describe('airTimeLabel', () => {
  it('uses the airDate clock when present', () => {
    expect(airTimeLabel('2026-09-09T02:00:00Z', null)).toBe('10:00 PM ET');
  });
  it('falls back to the provider string when airDate is a midnight-UTC date only', () => {
    expect(airTimeLabel('2026-09-09T00:00:00Z', '22:00')).toBe('10:00 PM ET');
  });
  it('is null when neither carries a time', () => {
    expect(airTimeLabel('2026-09-09T00:00:00Z', null)).toBeNull();
  });
});

describe('tvmazeEpisodeTimeLabel', () => {
  it('returns the real ET time for a broadcast (networked) show', () => {
    expect(
      tvmazeEpisodeTimeLabel({ airstamp: '2026-07-24T02:00:00Z' }, { network: { name: 'TruTV' } }),
    ).toBe('10:00 PM ET');
  });
  it('uses the streaming convention for TVmaze noon-UTC placeholder (no network)', () => {
    expect(
      tvmazeEpisodeTimeLabel(
        { airstamp: '2026-09-16T12:00:00Z' },
        { network: null, webChannel: { name: 'Prime Video' } },
      ),
    ).toBe('3:00 AM ET');
  });
  it('is null when there is no airstamp', () => {
    expect(tvmazeEpisodeTimeLabel({ airstamp: null }, { network: null })).toBeNull();
  });
});

describe('streamingDropET', () => {
  it('is plain "3:00 AM ET" with no tilde', () => {
    expect(streamingDropET('Netflix')).toBe('3:00 AM ET');
  });
});
