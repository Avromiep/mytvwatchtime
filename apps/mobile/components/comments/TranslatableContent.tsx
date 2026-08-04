import React, { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, StyleProp, TextStyle, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import RenderHtml from 'react-native-render-html';
import {
  SUPPORTED_LOCALES,
  type SupportedLocale,
  type TranslatableTextDto,
  type TranslationResultDto,
  type TranslationValueDto,
} from '@tvwatch/shared';
import { useTranslation } from 'react-i18next';
import { useFeatureFlags, useTranslateContent } from '../../api/hooks';
import { useAppearance } from '../../context/PreferencesProvider';
import { showDialog } from '../../lib/dialog';
import { spacing } from '../../theme/theme';
import { T } from '../primitives';

export function TranslatableContent({
  id,
  kind,
  content,
  style,
}: {
  id: string;
  kind: 'comment' | 'review';
  content: TranslatableTextDto;
  style?: StyleProp<TextStyle>;
}) {
  const { tokens, resolvedLocale } = useAppearance();
  const { t } = useTranslation(['comments']);
  const flags = useFeatureFlags();
  const mutation = useTranslateContent();
  const [target, setTarget] = useState<SupportedLocale>(resolvedLocale as SupportedLocale);
  const [translation, setTranslation] = useState<TranslationValueDto | TranslationResultDto | null>(
    content.translation ?? null,
  );
  const [translated, setTranslated] = useState(!!content.translation);
  const [sameLanguage, setSameLanguage] = useState(false);
  const { width } = useWindowDimensions();

  useEffect(() => {
    setTarget(resolvedLocale as SupportedLocale);
    setTranslation(content.translation ?? null);
    setTranslated(!!content.translation);
    setSameLanguage(false);
  }, [content.translation, resolvedLocale]);

  const canRequest = flags.data?.comment_translation ?? false;
  // A cached translation must always remain reversible, even if a later language-detection
  // response marks the original as ineligible for a new translation request.
  const visible = !sameLanguage && (!!translation || (content.eligible && canRequest));
  const sourceLanguage = translation?.sourceLanguage ?? content.sourceLanguage;
  const sourceLanguageName = useMemo(() => {
    if (!sourceLanguage) return null;
    try {
      return new Intl.DisplayNames([resolvedLocale], { type: 'language' }).of(sourceLanguage);
    } catch {
      return (
        SUPPORTED_LOCALES.find(
          ({ code }) =>
            code.toLowerCase().split('-')[0] === sourceLanguage.toLowerCase().split('-')[0],
        )?.nativeName ?? sourceLanguage
      );
    }
  }, [resolvedLocale, sourceLanguage]);
  const html = translated ? translation?.html : content.originalHtml;
  const text = translated ? translation?.text : content.original;
  const tagsStyles = useMemo(
    () => ({
      body: { color: tokens.textPrimary, fontSize: 15, lineHeight: 21 },
      p: { marginTop: 0, marginBottom: spacing.sm },
      a: { color: tokens.primary },
      blockquote: {
        borderLeftColor: tokens.border,
        borderLeftWidth: 3,
        paddingLeft: spacing.sm,
        color: tokens.textMuted,
      },
      code: { backgroundColor: tokens.surfaceElevated, color: tokens.textPrimary },
    }),
    [tokens],
  );

  const requestTranslation = async (language: SupportedLocale) => {
    setTarget(language);
    if (translation?.targetLanguage === language) {
      setTranslated((value) => !value);
      return;
    }
    try {
      const result = await mutation.mutateAsync({ kind, id, targetLanguage: language });
      if (result.sameLanguage) {
        setTranslation(null);
        setTranslated(false);
        setSameLanguage(true);
        const languageName =
          SUPPORTED_LOCALES.find(
            ({ code }) =>
              code.toLowerCase().split('-')[0] ===
              result.sourceLanguage.toLowerCase().split('-')[0],
          )?.nativeName ?? result.sourceLanguage;
        showDialog({
          title: t('comments:translationNotNeeded'),
          description: t('comments:alreadyInSelectedLanguage', { language: languageName }),
          buttons: [{ label: t('comments:close'), variant: 'secondary', closeOnPress: true }],
        });
        return;
      }
      setTranslation(result);
      setTranslated(true);
    } catch {
      showDialog({
        title: t('comments:translationFailed'),
        description: t('comments:translationFailedDescription'),
        buttons: [{ label: t('comments:close'), variant: 'secondary', closeOnPress: true }],
      });
    }
  };

  const chooseLanguage = () => {
    showDialog({
      title: t('comments:chooseTranslationLanguage'),
      buttons: SUPPORTED_LOCALES.map((locale) => ({
        label: locale.nativeName,
        variant: (target === locale.code ? 'primary' : 'secondary') as 'primary' | 'secondary',
        onPress: () => requestTranslation(locale.code),
        closeOnPress: true,
      })),
    });
  };

  return (
    <View>
      {html ? (
        <RenderHtml
          contentWidth={Math.max(1, width - spacing.xl * 2)}
          source={{ html }}
          tagsStyles={tagsStyles as any}
          renderersProps={{
            a: {
              onPress: (_event, href) => {
                if (/^https?:\/\//i.test(href)) void Linking.openURL(href);
              },
            },
          }}
        />
      ) : text ? (
        <T variant="body" style={style}>
          {text}
        </T>
      ) : null}
      {visible ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: spacing.xs }}>
          <Pressable
            onPress={() => requestTranslation(target)}
            onLongPress={chooseLanguage}
            disabled={mutation.isPending}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('comments:translate')}
            style={{ flexDirection: 'row', alignItems: 'center' }}
          >
            <Ionicons name="language-outline" size={16} color={tokens.primary} />
            <T variant="micro" style={{ color: tokens.primary, marginLeft: 4 }}>
              {mutation.isPending
                ? t('comments:translating')
                : translated
                  ? t('comments:showOriginal')
                  : t('comments:translate')}
            </T>
          </Pressable>
          {translated && sourceLanguageName ? (
            <T variant="micro" muted style={{ marginLeft: spacing.sm }}>
              {t('comments:translatedFrom', { language: sourceLanguageName })}
            </T>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
