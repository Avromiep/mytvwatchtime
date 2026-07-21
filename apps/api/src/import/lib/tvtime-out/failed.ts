// TV Time Out tvtime-failed-*.json parsing — reporting only.
//
// Shape: { date, total_failed, message, shows: [{ title, tvdbId }] }
// These shows could not be exported due to TV Time server timeouts; nothing here
// is ever staged — the list is logged so the user knows what is missing.

import { asObj, numOrNull, strOrNull } from '../tvtime-json/types';
import type { TvTimeOutFailedResult } from './types';

export function normalizeTvTimeOutFailed(data: unknown): TvTimeOutFailedResult {
  const root = asObj(data);
  const shows = Array.isArray(root?.shows) ? root.shows : [];
  const parsed = shows
    .map((s) => {
      const o = asObj(s);
      return o ? { title: strOrNull(o.title), tvdbId: numOrNull(o.tvdbId) } : null;
    })
    .filter((s): s is { title: string | null; tvdbId: number | null } => s !== null);
  return { total: numOrNull(root?.total_failed) ?? parsed.length, shows: parsed };
}
