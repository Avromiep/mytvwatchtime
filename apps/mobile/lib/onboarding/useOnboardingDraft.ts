import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DraftAction,
  OnboardingDraft,
  draftReducer,
  emptyDraft,
} from './draft';

const keyFor = (userId: string) => `tvwatch.onboarding.draft.${userId}.v1`;

/**
 * Quick-setup selection draft, persisted per user in AsyncStorage so leaving the
 * flow mid-way (or an app kill) resumes with selections intact. Cleared on a
 * successful apply or an explicit restart.
 */
export function useOnboardingDraft(userId: string | undefined) {
  const [draft, dispatch] = useReducer(draftReducer, undefined, emptyDraft);
  const [ready, setReady] = useState(false);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const readyRef = useRef(ready);
  readyRef.current = ready;

  // Load the persisted draft once per user.
  useEffect(() => {
    if (!userId) return;
    let mounted = true;
    setReady(false);
    AsyncStorage.getItem(keyFor(userId))
      .then((raw) => {
        if (!mounted || !raw) return;
        try {
          dispatch({ type: 'hydrate', draft: JSON.parse(raw) as OnboardingDraft });
        } catch {
          // Corrupt draft — start fresh rather than crash the flow.
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (mounted) setReady(true);
      });
    return () => {
      mounted = false;
    };
  }, [userId]);

  // Debounced persist on every change (after the initial load settles).
  useEffect(() => {
    if (!userId || !ready) return;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      AsyncStorage.setItem(keyFor(userId), JSON.stringify(draft)).catch(() => undefined);
    }, 300);
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, [draft, userId, ready]);

  const act = useCallback((a: DraftAction) => dispatch(a), []);
  /**
   * Write the pending debounced state NOW. Screens push-navigate while staying
   * mounted, and the next screen hydrates its own instance from AsyncStorage —
   * without a flush, a change made <300ms before navigation is invisible to
   * the next screen and gets overwritten by its first persist.
   */
  const flush = useCallback(
    (next?: OnboardingDraft) => {
      if (persistTimer.current) {
        clearTimeout(persistTimer.current);
        persistTimer.current = null;
      }
      if (userId && readyRef.current) {
        AsyncStorage.setItem(keyFor(userId), JSON.stringify(next ?? draftRef.current)).catch(
          () => undefined,
        );
      }
    },
    [userId],
  );
  const clear = useCallback(() => {
    dispatch({ type: 'clear' });
    if (userId) AsyncStorage.removeItem(keyFor(userId)).catch(() => undefined);
  }, [userId]);

  return { draft, ready, act, clear, flush };
}
