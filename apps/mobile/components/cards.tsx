import React, { useRef } from 'react';
import {
  Platform,
  Pressable,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Swipeable } from 'react-native-gesture-handler';
import { Link, router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import {
  Card,
  EmptyState,
  PosterImage,
  ProgressBar,
  SectionHeader,
  StatusChip,
  T,
  WatchButton,
  useWatchMenu,
  AnimatedFlatList,
} from './primitives';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing } from '../theme/theme';
import { useTranslation } from 'react-i18next';
import { firstNetwork } from '@tvwatch/shared';
import { useContentWidth } from '../hooks/useContentWidth';



function PosterCardImpl({
  id,
  kind,
  title,
  poster,
  progress,
  rating,
  year,
  releaseDate,
  upcomingLabel,
  releaseDateLabel,
  width = 130,
  style,
  typeBadge = false,
}: {
  id: string;
  kind: 'shows' | 'movies';
  title: string;
  poster?: string | null;
  progress?: number;
  /** TMDB vote average (1..10) — shown as a star badge on the poster when > 0. */
  rating?: number | null;
  /** Release/start year — small caption line under the title. */
  year?: number | null;
  /** Movie release date (ISO). When it's in the future, a "X DAYS" countdown pill is shown. */
  releaseDate?: string | null;
  /** Upcoming grid: the big line under the poster (e.g. "35 days left", "Today", "TBA"). */
  upcomingLabel?: string | null;
  /** Upcoming grid: formatted release date, rendered as a line under the poster. */
  releaseDateLabel?: string | null;
  width?: number;
  style?: StyleProp<ViewStyle>;
  /** Mixed-type grids (search): small tv/film icon badge on the poster's top-right. */
  typeBadge?: boolean;
}) {
  const { tokens } = useAppearance();
  const h = width * 1.5;
  const route = kind === 'shows' ? 'show' : 'movie';
  // Upcoming-movie countdown: whole days until release, only for a future date.
  const daysToRelease = kind === 'movies' && releaseDate ? daysUntilAir(releaseDate) : null;
  const showCountdown = daysToRelease != null && daysToRelease >= 0;

  const cardStyle = StyleSheet.flatten([
    {
      width,
      marginRight: spacing.md,
    },
    style,
  ]);

  return (
    <Link href={`/${route}/${id}` as any} asChild>
      <Pressable style={cardStyle}>
        <View style={{ borderRadius: radius.md, overflow: 'hidden' }}>
          <PosterImage uri={poster} style={{ width, height: h }} transition={0} />

          {rating != null && rating > 0 ? (
            <View
              style={{
                position: 'absolute',
                top: 4,
                left: 4,
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: tokens.mediaScrim,
                borderRadius: radius.sm,
                paddingHorizontal: 4,
                paddingVertical: 2,
              }}
            >
              <Ionicons name="star" size={10} color={tokens.warning} />
              <T variant="micro" style={{ color: tokens.mediaText, marginLeft: 2 }}>
                {rating.toFixed(1)}
              </T>
            </View>
          ) : null}

          {typeBadge ? (
            <View
              style={{
                position: 'absolute',
                top: 4,
                right: 4,
                backgroundColor: tokens.mediaScrim,
                borderRadius: radius.sm,
                padding: 3,
              }}
              pointerEvents="none"
            >
              <Ionicons
                name={kind === 'shows' ? 'tv-outline' : 'film-outline'}
                size={11}
                color={tokens.mediaText}
              />
            </View>
          ) : null}

          {showCountdown ? (
            <View
              style={{
                position: 'absolute',
                top: 4,
                right: 4,
                backgroundColor: tokens.primary,
                borderRadius: radius.sm,
                paddingHorizontal: 5,
                paddingVertical: 2,
              }}
              pointerEvents="none"
            >
              <T variant="micro" style={{ color: tokens.primaryForeground }}>
                {daysToRelease === 0
                  ? 'TODAY'
                  : `${daysToRelease} ${daysToRelease === 1 ? 'DAY' : 'DAYS'}`}
              </T>
            </View>
          ) : null}

          {progress !== undefined ? (
            <View
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                padding: 4,
              }}
            >
              <ProgressBar
                value={progress}
                color={progress >= 1 ? tokens.watched : tokens.primary}
              />
            </View>
          ) : null}
        </View>

        {upcomingLabel ? (
          <T variant="h2" numberOfLines={1} style={{ marginTop: 6 }}>
            {upcomingLabel}
          </T>
        ) : null}
        <T variant="caption" numberOfLines={2} style={{ marginTop: upcomingLabel ? 4 : 6 }}>
          {title}
        </T>
        {year ? (
          <T variant="micro" muted numberOfLines={1} style={{ marginTop: 2 }}>
            {year}
          </T>
        ) : null}
        {releaseDateLabel ? (
          <T variant="micro" muted numberOfLines={1} style={{ marginTop: 2 }}>
            {releaseDateLabel}
          </T>
        ) : null}
      </Pressable>
    </Link>
  );
}

// Memoized: big grids (Movies tab, My Shows) rebuild their row arrays on every
// paginated append, and re-rendering every visible PosterCard made the posters
// flicker. `style` is intentionally excluded from the comparison — call sites
// only pass static layout constants (e.g. { marginRight: 0 }).
export const PosterCard = React.memo(PosterCardImpl, (prev, next) =>
  prev.id === next.id &&
  prev.kind === next.kind &&
  prev.title === next.title &&
  prev.poster === next.poster &&
  prev.progress === next.progress &&
  prev.rating === next.rating &&
  prev.year === next.year &&
  prev.width === next.width &&
  prev.typeBadge === next.typeBadge,
);

export function PosterGrid({ data, kind, emptyTitle, emptyCta, minCardWidth = 96 }: { data: any[]; kind: 'shows' | 'movies'; emptyTitle: string; emptyCta?: string; minCardWidth?: number }) {
  const width = useContentWidth();
  if (!data || data.length === 0) return <EmptyState title={emptyTitle} cta={emptyCta} icon="layers-outline" />;
  const containerW = width - spacing.lg * 2;
  const gap = spacing.sm;
  // Minimum 3 cards per row — 2-wide poster grids look sparse on phones.
  const cols = Math.max(3, Math.floor((containerW + gap) / (minCardWidth + gap)));
  const cellW = Math.floor((containerW - gap * (cols - 1)) / cols);
  const rows: any[][] = [];
  for (let i = 0; i < data.length; i += cols) rows.push(data.slice(i, i + cols));
  return (
    <View>
      {rows.map((row, ri) => (
        <View key={ri} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.sm }}>
          {row.map((it) => (
            <PosterCard key={it.id} id={it.id} kind={kind} title={it.title} poster={it.images?.poster ?? it.posterUrl} progress={it.userProgress ?? (it.watched ? 1 : undefined)} rating={it.rating} year={cardYear(it)} releaseDate={it.releaseDate} width={cellW} style={{ marginRight: 0 }} />
          ))}
          {Array.from({ length: cols - row.length }).map((_, fi) => (
            <View key={'f' + fi} style={{ width: cellW }} />
          ))}
        </View>
      ))}
    </View>
  );
}

// Progress bars are only meaningful for shows the user tracks: in mixed lists
// (explore/trending/related) an untouched show would otherwise render an empty bar.
export function cardProgress(item: any): number | undefined {
  if (item.inWatchlist || item.favorite || (item.userProgress ?? 0) > 0) return item.userProgress;
  return undefined;
}

// Cards get a unified `year` from lite/list DTOs; full ShowDto/MovieDto expose
// yearStart/releaseYear instead. Pick whichever the row carries.
export function cardYear(item: any): number | null {
  return item?.year ?? item?.yearStart ?? item?.releaseYear ?? null;
}

// ---------------- Horizontal carousel ----------------
export function Carousel({ title, action, onAction, data, kind, width = 120 }: { title: string; action?: string; onAction?: () => void; data: any[]; kind: 'shows' | 'movies'; width?: number }) {
  if (!data || data.length === 0) return null;
  return (
    <View style={{ marginBottom: spacing.lg }}>
      <View style={{ paddingHorizontal: spacing.lg }}>
        <SectionHeader title={title} action={action} onAction={onAction} />
      </View>
      {/* AnimatedFlatList: refreshed rails morph (insert/reorder/remove)
          instead of swapping wholesale under the user's finger. */}
      <AnimatedFlatList
        horizontal
        data={data}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: spacing.lg }}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <PosterCard id={item.id} kind={kind} title={item.title} poster={item.images?.poster ?? item.posterUrl} progress={cardProgress(item)} rating={item.rating} year={cardYear(item)} releaseDate={item.releaseDate} width={width} />
        )}
      />
    </View>
  );
}

// ---------------- Episode card (watch list row) ----------------
/** Horizontal space reserved for the absolute watch button (26px + a small gap). */
const WATCH_BTN_CLEARANCE = 26 + spacing.xs;

function EpisodeCardImpl({
  item,
  onMarkWatched,
  onRewatch,
  onUnwatchOnce,
  onUnwatch,
}: {
  item: any;
  onMarkWatched?: () => void;
  onRewatch?: () => void;
  onUnwatchOnce?: () => void;
  onUnwatch?: () => void;
}) {
  const swipeRef = useRef<any>(null);
  const { tokens } = useAppearance();
  const { t } = useTranslation(['common']);
  const menu = useWatchMenu();
  const watched = !!item.episode.watched;
  const handleWatch = () =>
    menu({ watched, watchCount: item.episode.watchCount ?? 0, onMarkWatched, onRewatch, onUnwatchOnce, onUnwatch });

  const cardContent = (
    <View style={[styles.epCard, { backgroundColor: tokens.surface }]}>
      {/* Header: show title (tap → show page) + network. Sibling of the nav
          pressable below so it keeps its own action; the still stays clear. */}
      <View style={styles.epHeader}>
        <Pressable
          onPress={() => router.push(`/show/${item.showId}` as any)}
          hitSlop={6}
          style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'flex-end' }}
        >
          {/* flexShrink lets a long title truncate while the chevron stays visible.
              includeFontPadding:false (Android) removes the extra top font padding;
              flex-end aligns the chevron with the bottom of the text. */}
          <T
            variant="caption"
            numberOfLines={1}
            style={[
              { fontWeight: '700', color: tokens.primary, flexShrink: 1 },
              Platform.OS === 'android' ? { includeFontPadding: false } : null,
            ]}
          >
            {item.showTitle}
          </T>
          <Ionicons name="chevron-forward" size={12} color={tokens.primary} style={{ marginLeft: 2 }} />
        </Pressable>
        {item.network ? (
          <T variant="micro" muted style={{ marginLeft: spacing.sm }}>
            {firstNetwork(item.network)}
          </T>
        ) : null}
      </View>

      {/* Body: tapping the still or episode info navigates to the episode. No flex here:
          the card's height is content-driven (inside Swipeable), and a flex child in an
          auto-height column parent collapses to 0 on Android. */}
      <Pressable
        onPress={() => router.push(`/episode/${item.episode.id}` as any)}
        style={{ flexDirection: 'row' }}
      >
        <View style={styles.epStillWrap}>
          <PosterImage uri={item.episode.stillUrl ?? item.backdropUrl} style={styles.epStill} transition={0} />
        </View>
        <View style={{ flex: 1, marginLeft: spacing.md }}>
          <View style={[styles.row, { alignItems: 'center' }]}>
            <T variant="caption" muted>
              S{String(item.episode.seasonNumber).padStart(2, '0')} | E{String(item.episode.number).padStart(2, '0')}
            </T>
            {item.label ? <View style={{ marginLeft: spacing.sm }}><StatusChip label={item.label} /></View> : null}
            {item.remainingUnwatched > 1 ? (
              <T variant="caption" style={{ marginLeft: 'auto', color: tokens.primary }}>
                +{item.remainingUnwatched - 1}
              </T>
            ) : null}
          </View>
          {/* paddingRight keeps the title clear of the absolutely-positioned watch
              button (26px at the card's bottom-right) — without it a two-line title
              slides underneath the checkbox. Only the title needs it: the S/E row
              above sits clear of the button zone, so the +N counter keeps hugging
              the card's right edge. */}
          <T variant="h2" numberOfLines={2} style={{ marginTop: 2, paddingRight: WATCH_BTN_CLEARANCE }}>
            {item.episode.title}
          </T>
        </View>
      </Pressable>

      {/* Watch button: absolute sibling so it does its own action. */}
      <View style={styles.epWatchBtn}>
        <WatchButton watched={watched} watchCount={item.episode.watchCount} onPress={handleWatch} />
      </View>
    </View>
  );

  // Web: no swipe, just render card with watch button
  if (Platform.OS === 'web') return cardContent;

  // Mobile: swipeable wrapper
  return (
    <Swipeable
      ref={swipeRef}
      friction={2}
      rightThreshold={40}
      renderRightActions={() => (
        <View style={[styles.swipeAction, { backgroundColor: tokens.watched }]}>
          <Ionicons name={item.episode.watched ? 'checkmark-done' : 'checkmark-circle-outline'} size={24} color={tokens.primaryForeground} />
          <T variant="micro" style={{ color: tokens.primaryForeground, marginTop: 2 }}>{item.episode.watched ? t('common:watched') : t('common:watch')}</T>
        </View>
      )}
      onSwipeableRightOpen={() => {
        handleWatch();
        swipeRef.current?.close();
      }}
    >
      {cardContent}
    </Swipeable>
  );
}

// Memoized: watch-next lists render hundreds of these inside a ScrollView, and every
// mark-watched tap re-renders the parent (isPending flip + optimistic cache swap).
// React Query's structural sharing (and the optimistic transforms) keep `item`
// identity stable for unchanged rows, and the callbacks only close over stable
// mutation fns — so comparing item identity alone safely skips untouched cards.
export const EpisodeCard = React.memo(EpisodeCardImpl, (prev, next) => prev.item === next.item);

// ---------------- Stats card ----------------
export function StatsCard({ title, big, subtitle, children, style }: { title?: string; big?: string; subtitle?: string; children?: React.ReactNode; style?: ViewStyle }) {
  return (
    <Card style={[{ marginBottom: spacing.md }, style]}>
      {title ? <T variant="caption" muted>{title}</T> : null}
      {big ? <T variant="title" style={{ marginTop: spacing.xs }}>{big}</T> : null}
      {subtitle ? <T variant="caption" muted style={{ marginTop: 2 }}>{subtitle}</T> : null}
      {children}
    </Card>
  );
}

// ---------------- Badge grid ----------------
const BADGE_COLS = 3;

export function BadgeGrid({ badges }: { badges: any[] }) {
  const { tokens } = useAppearance();
  const [gridWidth, setGridWidth] = React.useState(0);
  const cellWidth = gridWidth > 0 ? (gridWidth - BADGE_COLS * 2 * spacing.xs) / BADGE_COLS : 0;
  const rows: any[][] = [];
  for (let i = 0; i < badges.length; i += BADGE_COLS) rows.push(badges.slice(i, i + BADGE_COLS));
  return (
    <View onLayout={(e) => setGridWidth(e.nativeEvent.layout.width)}>
      {cellWidth > 0
        ? rows.map((row, ri) => (
            <View key={ri} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.sm }}>
              {row.map((b) => (
                <View key={b.id} style={[styles.badge, { width: cellWidth, backgroundColor: tokens.surface, opacity: b.unlocked ? 1 : 0.4 }]}>
                  <T style={{ fontSize: 28 }}>{b.icon}</T>
                  <T variant="micro" style={{ marginTop: 4, textAlign: 'center' }}>
                    {b.name}
                  </T>
                  {!b.unlocked ? <T variant="micro" muted style={{ marginTop: 2 }}>{b.current}/{b.target}</T> : null}
                </View>
              ))}
              {Array.from({ length: BADGE_COLS - row.length }).map((_, fi) => (
                <View key={'f' + fi} style={{ width: cellWidth, marginHorizontal: spacing.xs }} />
              ))}
            </View>
          ))
        : null}
    </View>
  );
}

// ---------------- Notification item ----------------
export function NotificationItem({ item, onPress }: { item: any; onPress?: () => void }) {
  const { tokens } = useAppearance();
  const icon = notifIcon(item.category);
  return (
    <Pressable onPress={onPress} style={[styles.notif, { backgroundColor: tokens.surface, opacity: item.read ? 0.6 : 1 }]}>
      <View style={[styles.notifIcon, { backgroundColor: item.read ? tokens.surfaceElevated : tokens.primary }]}>
        {/* Read: icon sits on surfaceElevated, so it needs a normal text color —
            primaryForeground is near-black in both themes and vanishes on dark slate. */}
        <Ionicons name={icon} size={18} color={item.read ? tokens.textMuted : tokens.primaryForeground} />
      </View>
      <View style={{ flex: 1, marginLeft: spacing.md }}>
        <T variant="body" numberOfLines={2}>
          {item.title}
        </T>
        {item.body ? <T variant="caption" muted numberOfLines={1}>{item.body}</T> : null}
        <T variant="micro" muted style={{ marginTop: 2 }}>
          {timeAgo(item.createdAt)}
        </T>
      </View>
      {!item.read ? <View style={[styles.dot, { backgroundColor: tokens.primary }]} /> : null}
    </Pressable>
  );
}

// ---------------- Upcoming card ----------------
/** Whole-day difference between the air date and today, ignoring clock time so
 *  "airs later today" reads 0 and "airs tomorrow" reads 1. null when undated. */
function daysUntilAir(airDate: string): number | null {
  const d = new Date(airDate);
  if (Number.isNaN(d.getTime())) return null;
  // Air/release dates are date-only, stored as midnight UTC. Compare the date's UTC
  // calendar day to the local calendar day so users behind UTC don't see it a day early.
  const target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86400000);
}

/** Normalize a provider air-time string to 12-hour format with an ET label.
 *  Handles 24-hour ("22:00") and existing 12-hour ("10:00 PM") inputs; returns the
 *  raw value if it isn't a recognizable time. Provider air times for US network
 *  shows are Eastern, so we surface them as such. */
function formatAirTimeET(raw?: string | null): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  const twelve = /(\d{1,2}):(\d{2})\s*([AaPp][Mm])/.exec(s);
  if (twelve) return `${parseInt(twelve[1], 10)}:${twelve[2]} ${twelve[3].toUpperCase()} ET`;
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return s;
  let h = parseInt(m[1], 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ampm} ET`;
}

/** Day-of-month of the nth Sunday of a month (month is 0-indexed, UTC). */
function nthSundayOfMonth(year: number, month: number, n: number): number {
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay(); // 0 = Sunday
  return 1 + ((7 - firstDow) % 7) + (n - 1) * 7;
}

/** US Eastern offset in minutes for a UTC instant (EDT = -240, EST = -300). DST runs
 *  from 07:00 UTC on the 2nd Sunday of March to 06:00 UTC on the 1st Sunday of November.
 *  Computed with plain arithmetic — Hermes doesn't reliably support named IANA zones. */
function easternOffsetMinutes(utcMs: number): number {
  const y = new Date(utcMs).getUTCFullYear();
  const dstStart = Date.UTC(y, 2, nthSundayOfMonth(y, 2, 2), 7);
  const dstEnd = Date.UTC(y, 10, nthSundayOfMonth(y, 10, 1), 6);
  return utcMs >= dstStart && utcMs < dstEnd ? -240 : -300;
}

/** Air time as 12-hour Eastern. Prefers the real air moment embedded in airDate
 *  (when it carries a clock, not just a midnight-UTC date); otherwise falls back to
 *  the provider's separate air-time string. Returns null when no time is known. */
function airTimeLabel(airDate?: string | null, airTime?: string | null): string | null {
  if (airDate) {
    const t = new Date(airDate).getTime();
    const d = new Date(airDate);
    const hasClock = !Number.isNaN(t) && (d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0);
    if (hasClock) {
      const et = new Date(t + easternOffsetMinutes(t) * 60000);
      let h = et.getUTCHours();
      const min = et.getUTCMinutes();
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return `${h}:${String(min).padStart(2, '0')} ${ampm} ET`;
    }
  }
  return formatAirTimeET(airTime);
}

/** Format a full ISO instant (with tz offset) as 12-hour Eastern. */
function airstampToET(stamp?: string | null): string | null {
  if (!stamp) return null;
  const t = new Date(stamp).getTime();
  if (Number.isNaN(t)) return null;
  const et = new Date(t + easternOffsetMinutes(t) * 60000);
  let h = et.getUTCHours();
  const min = et.getUTCMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(min).padStart(2, '0')} ${ampm} ET`;
}

/** When the app has no air time of its own, look one up from TVmaze (free, public, no
 *  key). TVmaze's `airstamp` is a full timezone-aware instant — including streaming
 *  drop times — so we can convert it to the viewer's Eastern time. Queries are keyed by
 *  show/episode so React Query dedupes them across the many cards of one show. */
function useTvmazeAirTimeET(item: any, enabled: boolean): string | null {
  const name: string | undefined = item?.title;
  const season = item?.seasonNumber;
  const number = item?.episodeNumber;

  const showQ = useQuery({
    queryKey: ['tvmaze', 'show', name],
    queryFn: async () => {
      const r = await fetch(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(name!)}`);
      return r.ok ? r.json() : null;
    },
    enabled: enabled && !!name,
    staleTime: 24 * 60 * 60 * 1000,
    retry: 1,
  });
  const showId: number | undefined = showQ.data?.id;

  const epQ = useQuery({
    queryKey: ['tvmaze', 'ep', showId, season, number],
    queryFn: async () => {
      const r = await fetch(`https://api.tvmaze.com/shows/${showId}/episodebynumber?season=${season}&number=${number}`);
      return r.ok ? r.json() : null;
    },
    enabled: enabled && !!showId && season != null && number != null,
    staleTime: 6 * 60 * 60 * 1000,
    retry: 1,
  });

  if (!enabled) return null;
  const stamp: string | undefined = epQ.data?.airstamp;
  if (!stamp) return null; // episode not on TVmaze — no time to show
  const d = new Date(stamp);
  // TVmaze stores a fake "noon UTC" placeholder for streaming shows (no broadcast
  // network). Real per-episode streaming times don't exist in any free source, so
  // fall back to the platform's known drop convention instead.
  const isStreamingPlaceholder =
    !showQ.data?.network && d.getUTCHours() === 12 && d.getUTCMinutes() === 0;
  if (isStreamingPlaceholder) return streamingDropET(showQ.data?.webChannel?.name);
  return airstampToET(stamp);
}

/** Streaming release convention in ET. The major services (Netflix, Prime Video,
 *  Apple TV+, Disney+, Hulu, Max, Paramount+, Peacock) drop new episodes at
 *  12:00 AM Pacific = 3:00 AM ET. Marked "~" since it's the platform's standard
 *  time, not a per-episode confirmation. Free data sources have no real time. */
function streamingDropET(_platform?: string | null): string {
  return '3:00 AM ET';
}

export function UpcomingCard({ item }: { item: any }) {
  const { tokens } = useAppearance();
  const air = new Date(item.airDate);
  // Format in UTC so the label matches the stored calendar day (and the day count),
  // rather than rolling back a day for viewers behind UTC.
  const dateLabel = air.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const localTime = airTimeLabel(item.airDate, item.airTime);
  // App data usually has no time for these — look it up from TVmaze in that case.
  const tvmazeTime = useTvmazeAirTimeET(item, !localTime);
  const timeLabel = localTime ?? tvmazeTime;
  const days = daysUntilAir(item.airDate);
  return (
    <Link href={`/episode/${item.id}` as any} asChild>
      <Pressable style={StyleSheet.flatten([styles.upCard, { backgroundColor: tokens.surface }])}>
        <PosterImage uri={item.posterUrl} style={{ width: 56, height: 84, borderRadius: radius.sm }} transition={0} />
        <View style={{ flex: 1, marginLeft: spacing.md }}>
          <View style={[styles.row, { alignItems: 'center' }]}>
            <T variant="h2" numberOfLines={1} style={{ flex: 1 }}>
              {item.title}
            </T>
            {item.label ? <StatusChip label={item.label} /> : null}
          </View>
          <T variant="caption" muted>
            S{String(item.seasonNumber).padStart(2, '0')} E{String(item.episodeNumber).padStart(2, '0')} · {item.episodeTitle}
          </T>
          <View style={[styles.row, { alignItems: 'center', marginTop: 4 }]}>
            <Ionicons name="time-outline" size={13} color={tokens.textMuted} />
            <T variant="caption" muted style={{ marginLeft: 4 }}>
              {dateLabel}
              {timeLabel ? ` · ${timeLabel}` : ''}
            </T>
            {item.network ? (
              <T variant="micro" style={{ marginLeft: 'auto', color: tokens.primary }}>
                {firstNetwork(item.network)}
              </T>
            ) : null}
          </View>
        </View>
        <View style={styles.upCountdown}>
          {days == null ? (
            <T variant="h2" muted>TBA</T>
          ) : days < 0 ? null : days === 0 ? (
            // Airing today: a single medium-weight word instead of "0 DAYS".
            <T variant="h2">TODAY</T>
          ) : (
            // Only count down to upcoming airings; already-aired episodes (negative
            // day counts) show nothing in this slot.
            <>
              <T variant="title" style={{ fontSize: 26, lineHeight: 30 }}>
                {days}
              </T>
              <T variant="micro" muted style={{ letterSpacing: 0.5 }}>
                {days === 1 ? 'DAY' : 'DAYS'}
              </T>
            </>
          )}
        </View>
      </Pressable>
    </Link>
  );
}

// ---------------- Bar chart (SVG) ----------------
export function BarChart({ data, color, height = 90, formatValue }: { data: { label: string; value: number }[]; color?: string; height?: number; formatValue?: (value: number) => string }) {
  const { tokens } = useAppearance();
  const barColor = color ?? tokens.primary;
  const [selected, setSelected] = React.useState<number | null>(null);
  // Measured pixel height of the bar row. Percentage bar heights (`height: '60%'`)
  // resolve against a stretch-sized flex parent: fine under Yoga (native), but 0
  // under react-native-web — every bar collapsed to minHeight. Pixels work on both.
  const [rowH, setRowH] = React.useState(0);
  const max = Math.max(1, ...data.map((d) => d.value));
  const sel = selected != null ? data[selected] : null;
  return (
    <View style={{ marginTop: spacing.sm }}>
      <View style={{ height: 18, justifyContent: 'center' }}>
        {sel ? (
          <T variant="micro" style={{ color: barColor, textAlign: 'center' }}>
            {sel.label} · {formatValue ? formatValue(sel.value) : sel.value}
          </T>
        ) : null}
      </View>
      <View
        style={{ flexDirection: 'row', alignItems: 'flex-end', height }}
        onLayout={(e) => setRowH(e.nativeEvent.layout.height)}
      >
        {data.map((d, i) => (
          <Pressable
            key={i}
            onPress={() => setSelected(selected === i ? null : i)}
            accessibilityRole="button"
            style={{ flex: 1, marginHorizontal: 1, justifyContent: 'flex-end', alignSelf: 'stretch' }}
          >
            <View style={{ height: Math.max(2, Math.round((d.value / max) * rowH)), backgroundColor: barColor, borderRadius: 3, opacity: selected == null || selected === i ? 1 : 0.35 }} />
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: 'row', marginTop: 4 }}>
        {data.map((d, i) => (
          <T key={i} variant="micro" dim style={[{ flex: 1, textAlign: 'center' }, selected === i ? { color: barColor } : null]}>
            {d.label}
          </T>
        ))}
      </View>
    </View>
  );
}

function notifIcon(category: string): keyof typeof Ionicons.glyphMap {
  switch (category) {
    case 'BADGE': return 'ribbon';
    case 'FOLLOW': return 'person-add';
    case 'COMMENT_LIKE':
    case 'COMMENT_REPLY': return 'chatbubble';
    case 'EPISODE_TODAY':
    case 'EPISODE_SOON':
    case 'EPISODE_AIRED':
    case 'PREMIERE': return 'tv';
    case 'MOVIE_RELEASE': return 'film';
    case 'WATCHLIST_REMINDER': return 'notifications';
    case 'PROVIDER_ALERT': return 'play-circle';
    case 'CONTACT': return 'mail';
    default: return 'notifications';
  }
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString();
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: spacing.lg },
  epCard: { position: 'relative', borderRadius: radius.md, padding: spacing.sm, marginBottom: spacing.sm },
  epHeader: { height: 20, flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xs },
  swipeAction: { justifyContent: 'center', alignItems: 'center', width: 90, marginRight: spacing.sm, marginBottom: spacing.sm, borderRadius: radius.md },
  epStillWrap: { width: 130, height: 74, borderRadius: radius.sm, overflow: 'hidden', position: 'relative' },
  epStill: { width: '100%', height: '100%' },
  epWatchBtn: { position: 'absolute', right: spacing.sm, bottom: spacing.sm },
  upCard: { flexDirection: 'row', alignItems: 'center', borderRadius: radius.md, padding: spacing.sm, marginBottom: spacing.sm },
  upCountdown: { width: 60, marginLeft: spacing.sm, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row' },
  badge: { alignItems: 'center', borderRadius: radius.md, padding: spacing.md, marginHorizontal: spacing.xs },
  notif: { flexDirection: 'row', alignItems: 'center', borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  notifIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
