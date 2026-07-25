import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { router } from 'expo-router';
import { useReassignMedia } from '../api/hooks';
import { ResolveMediaModal, type ResolvedMedia } from '../components/ResolveMediaModal';
import { showError } from '../lib/dialog';
import { showToast } from '../lib/toast';

/**
 * "Reassign" flow for a movie detail page: opens a media-search modal to pick the
 * correct movie, calls the reassign endpoint, then navigates to the target movie.
 * Render `reassignModal` inside the screen that can open the flow.
 */
export function useReassign() {
  const { t } = useTranslation(['lists', 'common']);
  const reassign = useReassignMedia();
  const [source, setSource] = useState<{ id: string; title: string } | null>(null);

  const openReassign = (media: { id: string; title: string }) => setSource(media);

  const confirm = async (target: ResolvedMedia) => {
    if (!source || reassign.isPending) return;
    try {
      await reassign.mutateAsync({ sourceId: source.id, targetMediaId: target.id });
      setSource(null);
      showToast(t('lists:reassignSuccess'));
      router.replace(`/movie/${target.id}` as any);
    } catch (e: any) {
      showError({
        title: t('lists:failedToSave'),
        description: e?.message ?? t('common:pleaseTryAgain'),
      });
    }
  };

  const reassignModal = (
    <ResolveMediaModal
      visible={!!source}
      title={t('lists:reassign')}
      sourceTitle={source?.title ?? ''}
      isMovie
      onConfirm={confirm}
      onClose={() => setSource(null)}
    />
  );

  return { openReassign, reassignModal };
}
