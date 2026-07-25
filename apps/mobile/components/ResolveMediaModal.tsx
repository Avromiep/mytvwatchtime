import React, { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { MediaType } from '@tvwatch/shared';
import { useSearch } from '../api/hooks';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing } from '../theme/theme';
import { Button, PosterImage, Spinner, T } from './primitives';

/** Minimal media identity handed to the generic confirm handler. */
export interface ResolvedMedia {
  id: string;
  title: string;
  year?: number | null;
}

/** Import-only extras: apply-to-season/whole-show checkboxes, skip button, and the
 *  import-specific confirm (which needs the raw search result + checkbox state). */
export interface ImportResolveOptions {
  /** Micro line under the source title (entity type + SxEy tag). */
  subtitle: string;
  /** Season context: drives the apply-to-season label, smart sort, and "N+ seasons" hint. */
  season?: number | null;
  /** Show the apply-to-season / apply-to-whole-show checkboxes (show items only). */
  showBulkOptions: boolean;
  onConfirm: (
    result: any,
    bulk: { applyToSeason: boolean; applyToWholeShow: boolean },
  ) => Promise<void>;
  onSkip: () => Promise<void>;
  skipPending?: boolean;
}

/** Subtitle for a search result: type · seasons (shows) · year. */
function resultMeta(r: any, t: (k: string, o?: any) => string): string {
  const parts: string[] = [(r.type ?? '').toLowerCase()];
  if (r.type === MediaType.SHOW) {
    if (r.seasonsCount) parts.push(t('import:seasons', { count: r.seasonsCount }));
    if (r.yearStart) parts.push(String(r.yearStart));
  } else if (r.releaseYear) {
    parts.push(String(r.releaseYear));
  }
  return parts.filter(Boolean).join(' · ');
}

/**
 * Shared media-search modal: search shows + movies, pick the correct match.
 * Used by the import manual-review flow (with `importResolve` extras) and by the
 * movie "Reassign" flow (generic `onConfirm` only).
 */
export function ResolveMediaModal({
  visible,
  sourceTitle,
  isMovie,
  title,
  initialQuery,
  targetSeason,
  onConfirm,
  onClose,
  importResolve,
}: {
  visible: boolean;
  sourceTitle: string;
  isMovie: boolean;
  /** Header title; defaults to the import flow's "Resolve item". */
  title?: string;
  /** Search prefill on open; defaults to sourceTitle. */
  initialQuery?: string;
  /** Known target season (import episodes): smart sort + "N+ seasons" hint. */
  targetSeason?: number | null;
  onConfirm?: (media: ResolvedMedia) => void | Promise<void>;
  onClose: () => void;
  importResolve?: ImportResolveOptions;
}) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['import', 'common']);
  const [query, setQuery] = useState('');
  // Apply-to-all defaults to the active season; the user can switch to "whole show". Mutually
  // exclusive; both off = resolve just the single item.
  const [applyToSeason, setApplyToSeason] = useState(true);
  const [applyToWholeShow, setApplyToWholeShow] = useState(false);

  // On open: prefill the search with the show/movie name and reset the checkboxes (season on).
  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible && !wasVisible.current) {
      setApplyToSeason(true);
      setApplyToWholeShow(false);
      setQuery((initialQuery ?? sourceTitle).trim());
    }
    wasVisible.current = visible;
  }, [visible, initialQuery, sourceTitle]);

  const trimmed = visible ? query.trim() : '';
  // Search BOTH types at once — sources mistype entities (TV Time lists some movies as
  // shows, e.g. "Pirates of the Caribbean"), so shows and movies arrive in one merged list.
  const showsQ = useSearch(trimmed, MediaType.SHOW);
  const moviesQ = useSearch(trimmed, MediaType.MOVIE);
  const isSearching = showsQ.isFetching || moviesQ.isFetching;
  const resolveStyles = buildResolveStyles(tokens);

  if (!visible) return null;

  const season = importResolve?.season ?? null;
  // Smart sort: exact title first, then closest season count, then popularity.
  const targetSeasons = targetSeason ?? undefined;

  // useSearch is an infinite query — results live in data.pages[].items. Merged: shows + movies.
  const rawResults =
    trimmed.length > 1
      ? [
          ...(showsQ.data?.pages ?? []).flatMap((p) => p.items ?? []),
          ...(moviesQ.data?.pages ?? []).flatMap((p) => p.items ?? []),
        ]
      : [];

  const sortedResults = [...rawResults].sort((a: any, b: any) => {
    const aTitle = (a.title ?? '').toLowerCase();
    const bTitle = (b.title ?? '').toLowerCase();
    const q = trimmed.toLowerCase();
    // 1. Exact title match wins.
    const aExact = aTitle === q ? 0 : 1;
    const bExact = bTitle === q ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    // 2. Starts-with title.
    const aStarts = aTitle.startsWith(q) ? 0 : 1;
    const bStarts = bTitle.startsWith(q) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    // 3. Closest season count (if we know the target season).
    if (targetSeasons != null) {
      const aSeasons = a.seasonsCount ?? 0;
      const bSeasons = b.seasonsCount ?? 0;
      // Shows with fewer seasons than the import item can't be right — push them down hard.
      const aTooFew = aSeasons < targetSeasons ? 1000 : 0;
      const bTooFew = bSeasons < targetSeasons ? 1000 : 0;
      if (aTooFew !== bTooFew) return aTooFew - bTooFew;
      // Among valid candidates, closest season count wins.
      const aDiff = Math.abs(aSeasons - targetSeasons);
      const bDiff = Math.abs(bSeasons - targetSeasons);
      if (aDiff !== bDiff) return aDiff - bDiff;
    }
    // 4. Fallback: more episodes = more likely to be a real match.
    return (b.episodesCount ?? 0) - (a.episodesCount ?? 0);
  });
  const results = sortedResults;

  const pick = (result: any) => {
    if (importResolve) {
      void importResolve.onConfirm(result, { applyToSeason, applyToWholeShow });
    } else {
      void onConfirm?.({
        id: result.id,
        title: result.title,
        year: result.releaseYear ?? result.yearStart ?? null,
      });
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      {/* Keep the bottom sheet above the on-screen keyboard (RN Modal does not do this
          by itself, especially on Android). */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable style={resolveStyles.backdrop} onPress={onClose}>
          <Pressable
            style={[resolveStyles.sheet, { backgroundColor: tokens.surface }]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={resolveStyles.header}>
              <T variant="h2" numberOfLines={1}>
                {title ?? t('import:resolve')}
              </T>
              <Pressable onPress={onClose} hitSlop={8}>
                <Ionicons name="close" size={24} color={tokens.textPrimary} />
              </Pressable>
            </View>

            <T variant="caption" style={{ marginTop: spacing.xs }}>
              {t('import:sourceTitle')}:{' '}
              <T variant="caption" style={{ fontWeight: '700', color: tokens.textPrimary }}>
                {sourceTitle}
              </T>
            </T>
            {importResolve ? (
              <T variant="micro" muted style={{ marginTop: 2 }}>
                {importResolve.subtitle}
              </T>
            ) : null}

            {importResolve?.showBulkOptions ? (
              <View style={{ marginTop: spacing.sm }}>
                <Pressable
                  style={{ flexDirection: 'row', alignItems: 'center' }}
                  onPress={() =>
                    setApplyToSeason((prev) => {
                      const next = !prev;
                      if (next) setApplyToWholeShow(false);
                      return next;
                    })
                  }
                  hitSlop={6}
                >
                  <Ionicons
                    name={applyToSeason ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={applyToSeason ? tokens.primary : tokens.textMuted}
                  />
                  <T variant="caption" style={{ marginLeft: spacing.xs, flex: 1 }}>
                    {season != null
                      ? t('import:applyToAllSeason', { season })
                      : t('import:applyToAllEpisodes')}
                  </T>
                </Pressable>
                <Pressable
                  style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}
                  onPress={() =>
                    setApplyToWholeShow((prev) => {
                      const next = !prev;
                      if (next) setApplyToSeason(false);
                      return next;
                    })
                  }
                  hitSlop={6}
                >
                  <Ionicons
                    name={applyToWholeShow ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={applyToWholeShow ? tokens.primary : tokens.textMuted}
                  />
                  <T variant="caption" style={{ marginLeft: spacing.xs, flex: 1 }}>
                    {t('import:applyToWholeShow')}
                  </T>
                </Pressable>
              </View>
            ) : null}

            {importResolve ? (
              <Button
                title={t('import:skipItem')}
                variant="ghost"
                icon="close-circle-outline"
                onPress={() => void importResolve.onSkip()}
                loading={importResolve.skipPending}
                style={{ marginTop: spacing.md }}
              />
            ) : null}

            <T variant="caption" muted style={{ marginTop: spacing.md, marginBottom: spacing.xs }}>
              {t('import:searchToMatch')}
            </T>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t('import:searchPlaceholder')}
              placeholderTextColor={tokens.textMuted}
              style={[
                resolveStyles.input,
                { color: tokens.textPrimary, borderColor: tokens.divider },
              ]}
              autoFocus
            />

            {isSearching && query.trim().length > 1 ? (
              <Spinner />
            ) : results.length === 0 ? (
              query.trim().length > 1 ? (
                <T variant="micro" muted style={{ padding: spacing.md, textAlign: 'center' }}>
                  {t('import:noResults')}
                </T>
              ) : null
            ) : (
              <ScrollView style={{ maxHeight: 500 }} keyboardShouldPersistTaps="handled">
                {results.map((r: any) => {
                  const isExact = (r.title ?? '').toLowerCase() === trimmed.toLowerCase();
                  const seasonMatch =
                    targetSeasons != null && (r.seasonsCount ?? 0) >= targetSeasons;
                  return (
                    <Pressable
                      key={r.id}
                      onPress={() => pick(r)}
                      style={[
                        resolveStyles.resultRow,
                        isExact && {
                          backgroundColor: tokens.primary + '15',
                          borderColor: tokens.primary,
                          borderWidth: 1,
                        },
                      ]}
                    >
                      <PosterImage
                        uri={r.images?.poster ?? r.posterUrl}
                        style={resolveStyles.poster}
                      />
                      <View style={{ flex: 1 }}>
                        <T variant="body" numberOfLines={1}>
                          {r.title}
                        </T>
                        {r.originalTitle && r.originalTitle !== r.title ? (
                          <T variant="micro" muted numberOfLines={1}>
                            {r.originalTitle}
                          </T>
                        ) : null}
                        <T variant="micro" muted>
                          {resultMeta(r, t)}
                        </T>
                        {isExact && (
                          <T variant="micro" style={{ color: tokens.primary }}>
                            {t('import:exactMatch')}
                          </T>
                        )}
                        {seasonMatch && !isExact && (
                          <T variant="micro" style={{ color: tokens.primary }}>
                            {t('import:seasonsMatch', { count: targetSeasons })}
                          </T>
                        )}
                      </View>
                      <Ionicons name="checkmark-circle-outline" size={22} color={tokens.primary} />
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function buildResolveStyles(tokens: ReturnType<typeof useAppearance>['tokens']) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: tokens.overlayStrong, justifyContent: 'flex-end' },
    sheet: {
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      padding: spacing.lg,
      paddingBottom: 32,
    },
    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    input: {
      borderWidth: 1,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      fontSize: 16,
    },
    resultRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: tokens.divider,
    },

    poster: {
      width: 38,
      height: 57,
      marginRight: spacing.sm,
      borderRadius: radius.sm,
      backgroundColor: tokens.surfaceElevated,
    },
  });
}
