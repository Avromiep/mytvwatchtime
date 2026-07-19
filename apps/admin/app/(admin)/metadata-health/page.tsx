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
}

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
  const [batchCount, setBatchCount] = useState('200');
  const [batchRps, setBatchRps] = useState('');

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

  const runBackfill = () => {
    setBackfilling(true);
    setBackfillResult(null);
    api
      .post(`/admin/metadata-backfill/run?count=${batchCount}${batchRps ? `&rps=${batchRps}` : ''}`)
      .then(() => {
        setBackfillResult(`Backfill started (${batchCount} items${batchRps ? `, ${batchRps}/min` : ', full speed'}). Stats refresh in 30s.`);
        setTimeout(() => load(), 30000); // auto-refresh stats after 30s
      })
      .catch(() => setBackfillResult('Backfill failed to start.'))
      .finally(() => setBackfilling(false));
  };

  const runTmdbSync = () => {
    setSyncing(true);
    setSyncResult(null);
    api
      .post('/admin/tmdb-changes/run')
      .then(() => {
        setSyncResult('TMDB changes sync started in background. Check API logs for results.');
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
    api
      .post('/admin/cast-character-ids/run')
      .then(() => {
        setCastResult('Cast character-id backfill started in background. Stats refresh in 30s.');
        setTimeout(() => load(), 30000);
      })
      .catch(() => setCastResult('Cast backfill failed to start.'))
      .finally(() => setBackfillingCast(false));
  };

  if (!canView) return <p className="p-6 text-sm text-zinc-500">Admins only.</p>;

  const pct = (n: number) => (stats && stats.total > 0 ? Math.round((n / stats.total) * 100) : 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Metadata Health</h1>
        <div className="flex gap-3">
          <button onClick={load} className="text-sm text-blue-600 hover:underline">
            Refresh
          </button>
          <button
            onClick={runTmdbSync}
            disabled={syncing}
            className="rounded border border-blue-600 px-3 py-1 text-sm font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
          >
            {syncing ? 'Syncing…' : 'TMDB Changes Sync'}
          </button>
          <button
            onClick={runAnimeFix}
            disabled={fixingAnime}
            className="rounded border border-blue-600 px-3 py-1 text-sm font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
          >
            {fixingAnime ? 'Starting…' : 'Fix Anime → TVDB'}
          </button>
          <button
            onClick={runTypeRepair}
            disabled={repairing}
            className="rounded border border-blue-600 px-3 py-1 text-sm font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
          >
            {repairing ? 'Starting…' : 'Repair Type Mismatch'}
          </button>
          <button
            onClick={runCastBackfill}
            disabled={backfillingCast}
            className="rounded border border-blue-600 px-3 py-1 text-sm font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
          >
            {backfillingCast ? 'Starting…' : 'Backfill Character IDs'}
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

      {loading || !stats ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <>
          {/* Health metrics */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <MetricCard label="Total Media" value={stats.total} />
            <MetricCard label="Never Hydrated" value={stats.neverHydrated} sub={`${pct(stats.neverHydrated)}% of total`} highlight={stats.neverHydrated > 0} />
            <MetricCard label="Shows Missing Episodes" value={stats.showsMissingEpisodes} sub={`${pct(stats.showsMissingEpisodes)}% of total`} highlight={stats.showsMissingEpisodes > 0} />
            <MetricCard label="Movies Missing Overview" value={stats.moviesMissingOverview} sub={`${pct(stats.moviesMissingOverview)}% of total`} highlight={stats.moviesMissingOverview > 0} />
            <MetricCard label="TVDB-Only (no TMDB)" value={stats.tvdbOnly} sub={`${pct(stats.tvdbOnly)}% of total`} />
            <MetricCard
              label="Anime on TMDB"
              value={stats.animeOnTmdb}
              sub={`should be TVDB · ${stats.animeOnTmdbNoTvdbId} missing TVDB id`}
              highlight={stats.animeOnTmdb > 0}
            />
            <MetricCard
              label="Type Mismatch"
              value={stats.structuralTypeMismatch}
              sub="movie/show merged into one row"
              highlight={stats.structuralTypeMismatch > 0}
            />
            <MetricCard
              label="Cast Missing Character IDs"
              value={stats.castMissingCharacterIds}
              sub="shows with cast but no TVDB character ids"
              highlight={stats.castMissingCharacterIds > 0}
            />
            <MetricCard label="Stale (30+ days)" value={stats.stale} sub={`${pct(stats.stale)}% of total`} highlight={stats.stale > 0} />
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
            Backfill processes 20 items per run (oldest/never-hydrated first). It hydrates from TMDB (or TVDB for
            TVDB-only media), respects global rate limits, and enqueues anime classification (Kitsu &gt; Jikan &gt; TVDB
            &gt; TMDB). Watch history is never affected. Animation-genre shows are TVDB-authoritative: the daily Anime
            TVDB Rehydration job (Scheduled Jobs) and the Fix Anime button re-hydrate any TMDB-structured ones from
            TVDB, and TMDB Changes Sync skips them.
          </p>
        </>
      )}
    </div>
  );
}

function MetricCard({ label, value, sub, highlight }: { label: string; value: number; sub?: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border p-4 ${highlight ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950' : 'border-zinc-200 dark:border-zinc-700'}`}>
      <p className="text-xs uppercase tracking-wide text-zinc-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value.toLocaleString()}</p>
      {sub && <p className="mt-0.5 text-xs text-zinc-400">{sub}</p>}
    </div>
  );
}
