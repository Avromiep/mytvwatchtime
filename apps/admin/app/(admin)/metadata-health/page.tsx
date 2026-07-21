'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Badge } from '@/components/ui';

interface MetadataHealth {
  total: number;
  neverHydrated: number;
  showsMissingEpisodes: number;
  moviesMissingOverview: number;
  tvdbOnly: number;
  stale: number;
  byClassification: Record<string, number>;
  animeOnTmdb: number;
  animeOnTmdbNoTvdbId: number;
  structuralTypeMismatch: number;
  castMissingCharacterIds: number;
  movieDataOnShows: number;
  multiTvdbIds: number;
  nonEnglishBase: number;
  nonEnglishContent: number;
}

/** Live progress of one background repair job (from /admin/metadata-health/repair-progress). */
interface RepairProgress {
  running: boolean;
  processed: number;
  total: number;
  succeeded: number;
  failed: number;
  current?: string;
  finishedAt?: string;
}

const REPAIR_LABELS: Record<string, string> = {
  'character-ids': 'Character IDs backfill',
  'anime-rehydrate': 'Anime → TVDB rehydration',
  'tvdb-id-conflicts': 'TVDB ID conflict repair',
  'english-base': 'English base restore',
  'english-content': 'English content verify',
};

/** One-line guidance per stat: what it means and what to do about it. */
const STAT_HINTS: Record<string, string> = {
  total: 'All media rows in the local catalog (shows + movies).',
  neverHydrated: 'Rows with only a title (no metadata yet). Run Backfill to hydrate them.',
  showsMissingEpisodes:
    'Shows with zero seasons/episodes stored. Run Backfill to rehydrate their structure.',
  moviesMissingOverview: 'Movies missing their description text. Run Backfill to fill it.',
  tvdbOnly: 'Shows/movies that exist only on TVDB (no TMDB id) — informational, usually anime.',
  stale: 'Metadata older than 30 days. These refresh lazily on view; Run Backfill for a bulk pass.',
  animeOnTmdb:
    'Animation-genre shows whose structure came from TMDB (wrong season splits for anime). Fix moves them to TVDB and transfers watch data.',
  structuralTypeMismatch:
    'Movie and show merged into ONE row by a bad id cross-link. Repair splits them and transfers watch data.',
  castMissingCharacterIds:
    'Shows whose cast lacks TVDB character ids — needed to resolve imported character votes. Backfill rehydrates them from TVDB.',
  movieDataOnShows:
    'Movie statuses/history wrongly written on shows (import bug). The Repair button above purges these too.',
  multiTvdbIds:
    'Rows carrying more than one TVDB id — merge leftovers (harmless) or id poisoning from an old bug (one id belongs to a DIFFERENT show, mis-routing matches). Repair verifies each id via TMDB and detaches only the wrong ones. User history is never deleted.',
  nonEnglishBase:
    "Rows explicitly marked as having a non-English base title (title_locale ≠ en). Repair re-hydrates them with a proper English base and restores the 'en' override. Rows with an unset marker are NOT counted (most have a fine English base already). No user data touched.",
  nonEnglishContent:
    "Suspected wrong-language CONTENT with a lying/missing marker: the title an English user sees contains non-ASCII. Verify+Fix checks the most-popular suspects first against the provider's canonical English title and re-hydrates only real mismatches. Verified rows are remembered and leave this count (a title change re-arms them), so the number DRAINS as runs complete. Deep mode verifies every row — catches pure-ASCII foreign titles. A nightly Scheduled Job keeps it converged. No user data touched.",
};

const CLASSIFICATION_LABELS: Record<string, { label: string; color: string }> = {
  GENERAL: { label: 'General', color: 'default' },
  ANIME: { label: 'Anime', color: 'info' },
  MANGA: { label: 'Manga', color: 'warning' },
  UNKNOWN: { label: 'Unclassified', color: 'default' },
};

export default function MetadataHealthPage() {
  const { user } = useAuth();
  const [stats, setStats] = useState<MetadataHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [fixingAnime, setFixingAnime] = useState(false);
  const [animeResult, setAnimeResult] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [repairResult, setRepairResult] = useState<string | null>(null);
  const [backfillingCast, setBackfillingCast] = useState(false);
  const [castResult, setCastResult] = useState<string | null>(null);
  const [repairingTvdbIds, setRepairingTvdbIds] = useState(false);
  const [tvdbIdResult, setTvdbIdResult] = useState<string | null>(null);
  const [repairingEnBase, setRepairingEnBase] = useState(false);
  const [enBaseResult, setEnBaseResult] = useState<string | null>(null);
  const [enBaseCount, setEnBaseCount] = useState('200');
  const [repairingEnContent, setRepairingEnContent] = useState(false);
  const [enContentResult, setEnContentResult] = useState<string | null>(null);
  const [enContentCount, setEnContentCount] = useState('500');
  const [enContentDeep, setEnContentDeep] = useState(false);
  const [castCount, setCastCount] = useState('500');
  const [repairs, setRepairs] = useState<Record<string, RepairProgress>>({});
  const [batchCount, setBatchCount] = useState('200');
  const [batchRps, setBatchRps] = useState('');
  const [syncStart, setSyncStart] = useState('');

  const canView = user?.role && ['ADMIN', 'SUPER_ADMIN'].includes(user.role);

  const load = () => {
    setLoading(true);
    api
      .get('/admin/metadata-health')
      .then((r) => setStats(r.data))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (canView) load();
  }, [canView]);

  // Live repair progress — poll every 3s while the page is open.
  useEffect(() => {
    if (!canView) return;
    const loadRepairs = () =>
      api
        .get('/admin/metadata-health/repair-progress')
        .then((r) => setRepairs(r.data))
        .catch(() => undefined);
    loadRepairs();
    const id = setInterval(loadRepairs, 3000);
    return () => clearInterval(id);
  }, [canView]);

  const runBackfill = () => {
    setBackfilling(true);
    setBackfillResult(null);
    api
      .post(`/admin/metadata-backfill/run?count=${batchCount}${batchRps ? `&rps=${batchRps}` : ''}`)
      .then(() => {
        setBackfillResult(
          `Backfill started (${batchCount} items${batchRps ? `, ${batchRps}/min` : ', full speed'}). Stats refresh in 30s.`,
        );
        setTimeout(() => load(), 30000); // auto-refresh stats after 30s
      })
      .catch(() => setBackfillResult('Backfill failed to start.'))
      .finally(() => setBackfilling(false));
  };

  const runTmdbSync = () => {
    setSyncing(true);
    setSyncResult(null);
    const qs = syncStart ? `?start=${syncStart}` : '';
    api
      .post(`/admin/tmdb-changes/run${qs}`)
      .then(() => {
        setSyncResult(
          syncStart
            ? `TMDB changes sync (custom range from ${syncStart}) started in background. The daily cursor is untouched. Stats refresh in 60s.`
            : 'TMDB changes sync started in background. Check API logs for results.',
        );
        setTimeout(() => load(), 60000); // auto-refresh after 60s (sync takes longer)
      })
      .catch(() => setSyncResult('TMDB sync failed to start.'))
      .finally(() => setSyncing(false));
  };

  const runAnimeFix = () => {
    setFixingAnime(true);
    setAnimeResult(null);
    api
      .post('/admin/anime-tvdb-rehydrate/run')
      .then(() => {
        setAnimeResult('Anime TVDB rehydration started in background. Stats refresh in 30s.');
        setTimeout(() => load(), 30000); // auto-refresh stats after 30s
      })
      .catch(() => setAnimeResult('Anime TVDB rehydration failed to start.'))
      .finally(() => setFixingAnime(false));
  };

  const runTypeRepair = () => {
    setRepairing(true);
    setRepairResult(null);
    api
      .post('/admin/repair-type-mismatch/run')
      .then(() => {
        setRepairResult('Type mismatch repair started in background. Stats refresh in 30s.');
        setTimeout(() => load(), 30000);
      })
      .catch(() => setRepairResult('Type mismatch repair failed to start.'))
      .finally(() => setRepairing(false));
  };

  const runCastBackfill = () => {
    setBackfillingCast(true);
    setCastResult(null);
    const n = Math.max(1, Number(castCount) || 500);
    api
      .post(`/admin/cast-character-ids/run?count=${n}`)
      .then(() => {
        setCastResult(`Cast character-id backfill started (${n} shows). Stats refresh in 30s.`);
        setTimeout(() => load(), 30000);
      })
      .catch(() => setCastResult('Cast backfill failed to start.'))
      .finally(() => setBackfillingCast(false));
  };

  const runTvdbIdRepair = () => {
    setRepairingTvdbIds(true);
    setTvdbIdResult(null);
    api
      .post('/admin/repair-tvdb-id-conflicts/run')
      .then(() => {
        setTvdbIdResult('TVDB id-conflict repair started in background. Stats refresh in 60s.');
        setTimeout(() => load(), 60000);
      })
      .catch(() => setTvdbIdResult('TVDB id-conflict repair failed to start.'))
      .finally(() => setRepairingTvdbIds(false));
  };

  const runEnBaseRepair = () => {
    setRepairingEnBase(true);
    setEnBaseResult(null);
    const n = Math.max(1, Number(enBaseCount) || 200);
    api
      .post(`/admin/repair-non-english-base/run?count=${n}`)
      .then(() => {
        setEnBaseResult(`Non-English base repair started (${n} rows). Stats refresh in 60s.`);
        setTimeout(() => load(), 60000);
      })
      .catch(() => setEnBaseResult('Non-English base repair failed to start.'))
      .finally(() => setRepairingEnBase(false));
  };

  const runEnContentRepair = () => {
    setRepairingEnContent(true);
    setEnContentResult(null);
    const n = Math.max(1, Number(enContentCount) || 500);
    api
      .post(`/admin/repair-english-content/run?count=${n}${enContentDeep ? '&deep=1' : ''}`)
      .then(() => {
        setEnContentResult(
          `English-content verify+repair started (${n} rows${enContentDeep ? ', deep scan' : ''}). Watch the progress panel above; stats refresh in 60s.`,
        );
        setTimeout(() => load(), 60000);
      })
      .catch(() => setEnContentResult('English-content repair failed to start.'))
      .finally(() => setRepairingEnContent(false));
  };

  if (!canView) return <p className="p-6 text-sm text-zinc-500">Admins only.</p>;

  const pct = (n: number) => (stats && stats.total > 0 ? Math.round((n / stats.total) * 100) : 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Metadata Health</h1>
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={load} className="text-sm text-blue-600 hover:underline">
            Refresh
          </button>
          <span className="text-xs text-zinc-400">TMDB sync from:</span>
          <input
            type="date"
            value={syncStart}
            onChange={(e) => setSyncStart(e.target.value)}
            className="rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-600 dark:bg-zinc-800"
          />
          <button
            onClick={runTmdbSync}
            disabled={syncing}
            className="rounded border border-blue-600 px-3 py-1 text-sm font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
          >
            {syncing ? 'Syncing…' : syncStart ? 'Sync (custom range)' : 'TMDB Changes Sync'}
          </button>
          <button
            onClick={runBackfill}
            disabled={backfilling}
            className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {backfilling ? 'Running…' : `Run Backfill`}
          </button>
          <input
            type="number"
            value={batchCount}
            onChange={(e) => setBatchCount(e.target.value)}
            className="w-20 rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-600 dark:bg-zinc-800"
            placeholder="200"
          />
          <span className="text-xs text-zinc-400">items/min:</span>
          <input
            type="number"
            value={batchRps}
            onChange={(e) => setBatchRps(e.target.value)}
            className="w-16 rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-600 dark:bg-zinc-800"
            placeholder="full"
          />
        </div>
      </div>

      {syncResult && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200">
          {syncResult}
        </div>
      )}
      {backfillResult && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200">
          {backfillResult}
        </div>
      )}
      {animeResult && (
        <div className="rounded-lg border border-purple-200 bg-purple-50 p-3 text-sm text-purple-800 dark:border-purple-800 dark:bg-purple-950 dark:text-purple-200">
          {animeResult}
        </div>
      )}
      {repairResult && (
        <div className="rounded-lg border border-purple-200 bg-purple-50 p-3 text-sm text-purple-800 dark:border-purple-800 dark:bg-purple-950 dark:text-purple-200">
          {repairResult}
        </div>
      )}
      {castResult && (
        <div className="rounded-lg border border-teal-200 bg-teal-50 p-3 text-sm text-teal-800 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-200">
          {castResult}
        </div>
      )}
      {tvdbIdResult && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-200">
          {tvdbIdResult}
        </div>
      )}
      {enBaseResult && (
        <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200">
          {enBaseResult}
        </div>
      )}
      {enContentResult && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200">
          {enContentResult}
        </div>
      )}

      {/* Live repair progress (polls every 3s; finished jobs stay visible ~60s) */}
      {Object.keys(repairs).length > 0 && (
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
          <h2 className="mb-3 font-medium">Repair progress</h2>
          <div className="space-y-3">
            {Object.entries(repairs).map(([job, p]) => {
              const pctDone =
                p.total > 0 ? Math.min(100, Math.round((p.processed / p.total) * 100)) : 0;
              return (
                <div key={job}>
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-medium">
                      {REPAIR_LABELS[job] ?? job}
                      {!p.running && (
                        <span className="ml-2 text-xs font-normal text-green-600 dark:text-green-400">
                          done
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-xs text-zinc-400">
                      {p.processed}/{p.total} · {p.succeeded} ok / {p.failed} fail
                    </span>
                  </div>
                  <div className="mt-1 h-2 w-full overflow-hidden rounded bg-zinc-200 dark:bg-zinc-700">
                    <div
                      className={`h-2 rounded transition-all ${p.running ? 'bg-blue-600' : 'bg-green-600'}`}
                      style={{ width: `${p.total > 0 ? pctDone : p.running ? 5 : 100}%` }}
                    />
                  </div>
                  {p.running && p.current && (
                    <p className="mt-0.5 truncate text-xs text-zinc-400">{p.current}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {loading || !stats ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <>
          {/* Health metrics */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <MetricCard label="Total Media" value={stats.total} hint={STAT_HINTS.total} />
            <MetricCard
              label="Never Hydrated"
              value={stats.neverHydrated}
              sub={`${pct(stats.neverHydrated)}% of total`}
              hint={STAT_HINTS.neverHydrated}
              highlight={stats.neverHydrated > 0}
            />
            <MetricCard
              label="Shows Missing Episodes"
              value={stats.showsMissingEpisodes}
              sub={`${pct(stats.showsMissingEpisodes)}% of total`}
              hint={STAT_HINTS.showsMissingEpisodes}
              highlight={stats.showsMissingEpisodes > 0}
            />
            <MetricCard
              label="Movies Missing Overview"
              value={stats.moviesMissingOverview}
              sub={`${pct(stats.moviesMissingOverview)}% of total`}
              hint={STAT_HINTS.moviesMissingOverview}
              highlight={stats.moviesMissingOverview > 0}
            />
            <MetricCard
              label="TVDB-Only (no TMDB)"
              value={stats.tvdbOnly}
              sub={`${pct(stats.tvdbOnly)}% of total`}
              hint={STAT_HINTS.tvdbOnly}
            />
            <MetricCard
              label="Stale (30+ days)"
              value={stats.stale}
              sub={`${pct(stats.stale)}% of total`}
              hint={STAT_HINTS.stale}
              highlight={stats.stale > 0}
            />
            <MetricCard
              label="Anime on TMDB"
              value={stats.animeOnTmdb}
              sub={`should be TVDB · ${stats.animeOnTmdbNoTvdbId} missing TVDB id`}
              hint={STAT_HINTS.animeOnTmdb}
              highlight={stats.animeOnTmdb > 0}
              action={
                <button
                  onClick={runAnimeFix}
                  disabled={fixingAnime}
                  className="rounded border border-blue-600 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                >
                  {fixingAnime ? 'Starting…' : 'Fix Anime → TVDB'}
                </button>
              }
            />
            <MetricCard
              label="Type Mismatch"
              value={stats.structuralTypeMismatch}
              sub="movie/show merged into one row"
              hint={STAT_HINTS.structuralTypeMismatch}
              highlight={stats.structuralTypeMismatch > 0}
              action={
                <button
                  onClick={runTypeRepair}
                  disabled={repairing}
                  className="rounded border border-blue-600 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                >
                  {repairing ? 'Starting…' : 'Repair Type Mismatch'}
                </button>
              }
            />
            <MetricCard
              label="Movie Data on Shows"
              value={stats.movieDataOnShows}
              sub="movie statuses/history on shows"
              hint={STAT_HINTS.movieDataOnShows}
              highlight={stats.movieDataOnShows > 0}
            />
            <MetricCard
              label="Cast Missing Character IDs"
              value={stats.castMissingCharacterIds}
              sub="shows with cast but no TVDB character ids"
              hint={STAT_HINTS.castMissingCharacterIds}
              highlight={stats.castMissingCharacterIds > 0}
              action={
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={castCount}
                    onChange={(e) => setCastCount(e.target.value)}
                    className="w-20 rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800"
                    title="Shows per run"
                  />
                  <button
                    onClick={runCastBackfill}
                    disabled={backfillingCast}
                    className="rounded border border-blue-600 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                  >
                    {backfillingCast ? 'Starting…' : 'Backfill Character IDs'}
                  </button>
                </div>
              }
            />
            <MetricCard
              label="Multiple TVDB IDs"
              value={stats.multiTvdbIds}
              sub="rows with conflicting TVDB ids"
              hint={STAT_HINTS.multiTvdbIds}
              highlight={stats.multiTvdbIds > 0}
              action={
                <button
                  onClick={runTvdbIdRepair}
                  disabled={repairingTvdbIds}
                  className="rounded border border-blue-600 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                >
                  {repairingTvdbIds ? 'Starting…' : 'Repair TVDB IDs'}
                </button>
              }
            />
            <MetricCard
              label="Non-English Base"
              value={stats.nonEnglishBase}
              sub="rows missing a trusted English base"
              hint={STAT_HINTS.nonEnglishBase}
              highlight={stats.nonEnglishBase > 0}
              action={
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={enBaseCount}
                    onChange={(e) => setEnBaseCount(e.target.value)}
                    className="w-20 rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800"
                    title="Rows per run"
                  />
                  <button
                    onClick={runEnBaseRepair}
                    disabled={repairingEnBase}
                    className="rounded border border-blue-600 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                  >
                    {repairingEnBase ? 'Starting…' : 'Restore English Base'}
                  </button>
                </div>
              }
            />
            <MetricCard
              label="Non-English Content (suspected)"
              value={stats.nonEnglishContent}
              sub="unverified suspects — most-visible first"
              hint={STAT_HINTS.nonEnglishContent}
              highlight={stats.nonEnglishContent > 0}
              action={
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={enContentCount}
                    onChange={(e) => setEnContentCount(e.target.value)}
                    className="w-20 rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800"
                    title="Rows per run"
                  />
                  <label className="flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                    <input
                      type="checkbox"
                      checked={enContentDeep}
                      onChange={(e) => setEnContentDeep(e.target.checked)}
                    />
                    deep (all rows)
                  </label>
                  <button
                    onClick={runEnContentRepair}
                    disabled={repairingEnContent}
                    className="rounded border border-blue-600 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                  >
                    {repairingEnContent ? 'Starting…' : 'Verify & Fix English'}
                  </button>
                </div>
              }
            />
          </div>

          {/* Classification breakdown */}
          <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
            <h2 className="mb-3 font-medium">Content Classification</h2>
            <div className="flex flex-wrap gap-3">
              {Object.entries(stats.byClassification).map(([key, count]) => {
                const meta = CLASSIFICATION_LABELS[key] ?? { label: key, color: 'default' };
                return (
                  <div key={key} className="flex items-center gap-2">
                    <Badge color={meta.color as any}>{meta.label}</Badge>
                    <span className="font-mono text-sm">{count}</span>
                    <span className="text-xs text-zinc-400">({pct(count)}%)</span>
                  </div>
                );
              })}
            </div>
          </div>

          <p className="text-xs text-zinc-400">
            Backfill processes 20 items per run (oldest/never-hydrated first). It hydrates from TMDB
            (or TVDB for TVDB-only media), respects global rate limits, and enqueues anime
            classification (Kitsu &gt; Jikan &gt; TVDB &gt; TMDB). Watch history is never affected.
            Animation-genre shows are TVDB-authoritative: the daily Anime TVDB Rehydration job
            (Scheduled Jobs) and the Fix Anime button re-hydrate any TMDB-structured ones from TVDB,
            and TMDB Changes Sync skips them.
          </p>
        </>
      )}
    </div>
  );
}

function MetricCard({
  label,
  value,
  sub,
  hint,
  highlight,
  action,
}: {
  label: string;
  value: number;
  sub?: string;
  hint?: string;
  highlight?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${highlight ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950' : 'border-zinc-200 dark:border-zinc-700'}`}
    >
      <p className="text-xs uppercase tracking-wide text-zinc-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value.toLocaleString()}</p>
      {sub && <p className="mt-0.5 text-xs text-zinc-400">{sub}</p>}
      {hint && (
        <p className="mt-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{hint}</p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
