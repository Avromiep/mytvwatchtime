import { Linking, Pressable, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { WatchProviderDto, WatchProvidersBlockDto } from '@tvwatch/shared';
import { PosterImage, T } from './primitives';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing } from '../theme/theme';

function ProviderTile({ p }: { p: WatchProviderDto }) {
  return (
    <View style={{ alignItems: 'center', width: 64, marginRight: spacing.sm }}>
      <PosterImage uri={p.logoUrl} style={{ width: 44, height: 44, borderRadius: radius.sm }} />
      <T variant="micro" muted style={{ textAlign: 'center', marginTop: 2 }} numberOfLines={2}>
        {p.name}
      </T>
    </View>
  );
}

function OfferRow({ label, providers }: { label: string; providers: WatchProviderDto[] }) {
  if (providers.length === 0) return null;
  return (
    <View style={{ marginTop: spacing.sm }}>
      <T variant="caption" muted>
        {label}:
      </T>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginTop: spacing.xs }}
      >
        {providers.map((p) => (
          <ProviderTile key={p.id} p={p} />
        ))}
      </ScrollView>
    </View>
  );
}

/** Stream/Rent/Buy offer rows for the request-locale country, one horizontal row per
 *  offer type, each hidden when empty. Falls back to the legacy flat provider list
 *  (US-only) for media not yet rehydrated with the per-country blob.
 *  JustWatch attribution is required by the TMDB API terms — never remove it. */
export function WhereToWatch({
  watchProviders,
  legacyProviders,
  emptyLabel,
}: {
  watchProviders?: WatchProvidersBlockDto | null;
  legacyProviders?: WatchProviderDto[];
  emptyLabel: string;
}) {
  const { tokens } = useAppearance();
  const { t } = useTranslation('common');
  const stream = watchProviders?.stream ?? [];
  const rent = watchProviders?.rent ?? [];
  const buy = watchProviders?.buy ?? [];
  const hasOffers = stream.length > 0 || rent.length > 0 || buy.length > 0;
  const legacy = !hasOffers && !watchProviders ? (legacyProviders ?? []) : [];
  if (!hasOffers && legacy.length === 0) {
    return (
      <T variant="caption" muted>
        {emptyLabel}
      </T>
    );
  }
  return (
    <View>
      {hasOffers ? (
        <>
          <OfferRow label={t('providersStream')} providers={stream} />
          <OfferRow label={t('providersRent')} providers={rent} />
          <OfferRow label={t('providersBuy')} providers={buy} />
        </>
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
          {legacy.map((p) => (
            <ProviderTile key={p.id} p={p} />
          ))}
        </View>
      )}
      {/* JustWatch attribution — TMDB API terms require it wherever offers display. */}
      <Pressable
        onPress={() => Linking.openURL(watchProviders?.link ?? 'https://www.justwatch.com')}
        style={{ marginTop: spacing.sm }}
      >
        <T variant="micro" style={{ color: tokens.textMuted, fontStyle: 'italic' }}>
          {t('providersAttribution')}
        </T>
      </Pressable>
    </View>
  );
}
