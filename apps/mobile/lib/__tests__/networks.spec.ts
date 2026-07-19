import { firstNetwork, formatNetworks, MAX_NETWORKS_PER_SHOW, NETWORK_SEPARATOR } from '@tvwatch/shared';

describe('network helpers', () => {
  it('joins trimmed, deduped names with the separator', () => {
    expect(formatNetworks([' TV Tokyo ', 'AT-X'])).toBe(`TV Tokyo${NETWORK_SEPARATOR}AT-X`);
    expect(formatNetworks(['HBO', 'HBO', 'hbo '])).toBe(`HBO${NETWORK_SEPARATOR}hbo`);
    expect(formatNetworks(['HBO'])).toBe('HBO');
  });

  it('caps at MAX_NETWORKS_PER_SHOW', () => {
    expect(formatNetworks(['A', 'B', 'C'])).toBe(`A${NETWORK_SEPARATOR}B`);
    expect(MAX_NETWORKS_PER_SHOW).toBe(2);
  });

  it('returns null when nothing usable is given', () => {
    expect(formatNetworks([])).toBeNull();
    expect(formatNetworks([null, ' ', undefined])).toBeNull();
  });

  it('firstNetwork returns the first segment of a joined string', () => {
    expect(firstNetwork(`TV Tokyo${NETWORK_SEPARATOR}AT-X`)).toBe('TV Tokyo');
    expect(firstNetwork('HBO')).toBe('HBO');
  });

  it('firstNetwork handles empty input', () => {
    expect(firstNetwork(null)).toBeNull();
    expect(firstNetwork(undefined)).toBeNull();
    expect(firstNetwork('')).toBeNull();
  });
});
