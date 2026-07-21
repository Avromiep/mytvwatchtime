// TV Time Out (browser extension) export: file classification + archive-level detection.
//
// The zip contains dated files:
//   tvtime-series-<date>.json   → parsed (watched episodes + watchlist + favorites)
//   tvtime-movies-<date>.json   → parsed (watched movies + watchlist + favorites)
//   tvtime-failed-<date>.json   → parsed for reporting only (shows that failed export)
//   tvtime-summary-<date>.html  → unsupported (human-readable summary)
//
// Classification works on the lowercase basename (files may sit in subfolders).
// The tvtime- prefix cannot collide with the Trakt (watched-history-*, …) or
// tvtime-json (shows.json, …) markers, but this detector is still checked AFTER
// both in the processor dispatch chain.

export type TvTimeOutFileKind = 'series' | 'movies' | 'failed' | 'summary' | 'unsupported';

/** Lowercase basename without directories. */
const base = (filename: string): string =>
  (filename.replace(/\\/g, '/').split('/').pop() ?? filename).toLowerCase();

const KIND_RE = /^tvtime-(series|movies|failed|summary)-.+\.(json|html)$/;

/** Classify one file of a TV Time Out export by name. Unknown → 'unsupported'. */
export function classifyTvTimeOutFile(filename: string): TvTimeOutFileKind {
  const m = base(filename).match(KIND_RE);
  if (!m) return 'unsupported';
  return m[1] as TvTimeOutFileKind;
}

/**
 * Heuristic: does this file list look like a TV Time Out export? True when ANY
 * entry basename matches the dated tvtime-(series|movies|failed|summary) pattern.
 */
export function isTvTimeOutArchive(filenames: string[]): boolean {
  return filenames.some((name) => classifyTvTimeOutFile(name) !== 'unsupported');
}

/** Basenames accepted as a standalone single-file JSON upload (mirrors the Trakt path). */
export function isTvTimeOutStandaloneFile(filename: string): boolean {
  const kind = classifyTvTimeOutFile(filename);
  return kind === 'series' || kind === 'movies';
}
