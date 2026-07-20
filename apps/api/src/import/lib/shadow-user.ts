// Deterministic shadow-usernames for imported third-party comment authors. The same
// (source, externalAuthorId) always yields the same name, so re-imports are idempotent
// and the identity is shared when two different users' archives contain the same author.

const ADJECTIVES = [
  'Blue',
  'Crimson',
  'Silent',
  'Golden',
  'Misty',
  'Rapid',
  'Cosmic',
  'Velvet',
  'Amber',
  'Iron',
  'Lunar',
  'Solar',
  'Wild',
  'Quiet',
  'Scarlet',
  'Frosty',
  'Ember',
  'Storm',
  'Neon',
  'Rustic',
];
const ANIMALS = [
  'Panda',
  'Falcon',
  'Otter',
  'Lynx',
  'Wolf',
  'Fox',
  'Hawk',
  'Bear',
  'Tiger',
  'Raven',
  'Dolphin',
  'Koala',
  'Badger',
  'Moose',
  'Heron',
  'Viper',
  'Bison',
  'Gecko',
  'Llama',
  'Owl',
];

/** FNV-1a 32-bit hash (stable, non-cryptographic). */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic friendly username like "BluePanda42" from a seed string. */
export function shadowUsername(seed: string): string {
  const h = fnv(seed);
  const adj = ADJECTIVES[h % ADJECTIVES.length];
  const animal = ANIMALS[(h >>> 5) % ANIMALS.length];
  const num = (h >>> 10) % 100;
  return `${adj}${animal}${num}`;
}

/** Shadow account email identity (unique per source + external author id). */
export function shadowEmail(source: string, externalAuthorId: string): string {
  return `shadow+${source.toLowerCase()}-${externalAuthorId}@shadow.local`;
}
