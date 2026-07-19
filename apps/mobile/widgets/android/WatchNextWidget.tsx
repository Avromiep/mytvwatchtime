import React from 'react';
import { FlexWidget, TextWidget, ImageWidget } from 'react-native-android-widget';
import type { Tokens, WatchNextItemDto } from '@tvwatch/shared';
import {
  EPISODE_URI,
  SHOWS_URI,
  episodeCode,
  type WidgetLabels,
  type WidgetFetchState,
} from '../data';

const hex = (c: string) => c as `#${string}`;
const img = (u: string) => u as React.ComponentProps<typeof ImageWidget>['image'];

const ROW_H = 66;
const ROW_GAP = 8;
const HEADER_H = 26;
const PAD = 12;

interface Props {
  state: WidgetFetchState<WatchNextItemDto[]>;
  labels: WidgetLabels;
  tokens: Tokens;
  height: number;
}

function WatchNextRow({ item, tokens }: { item: WatchNextItemDto; tokens: Tokens }) {
  const still = item.episode.stillUrl ?? item.backdropUrl ?? undefined;
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri: EPISODE_URI(item.episode.id) }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: hex(tokens.surface),
        borderRadius: 12,
        padding: 6,
        height: ROW_H,
        width: 'match_parent',
      }}
    >
      {still ? (
        <ImageWidget
          image={img(still)}
          imageWidth={88}
          imageHeight={50}
          radius={8}
          resizeMode="cover"
          style={{ width: 88, height: 50, marginRight: 10 }}
        />
      ) : null}
      <FlexWidget style={{ flexDirection: 'column', flex: 1 }}>
        <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent' }}>
          <FlexWidget style={{ flex: 1 }}>
            <TextWidget
              text={item.showTitle}
              truncate="END"
              maxLines={1}
              style={{ color: hex(tokens.primary), fontSize: 11, fontWeight: '700' }}
            />
          </FlexWidget>
          {item.network ? (
            <TextWidget
              text={item.network}
              maxLines={1}
              style={{ color: hex(tokens.textMuted), fontSize: 9, marginLeft: 6 }}
            />
          ) : null}
        </FlexWidget>
        <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
          <TextWidget
            text={episodeCode(item.episode.seasonNumber, item.episode.number, ' | ')}
            style={{ color: hex(tokens.textMuted), fontSize: 10, fontWeight: '500' }}
          />
          {item.remainingUnwatched > 1 ? (
            <TextWidget
              text={`+${item.remainingUnwatched - 1}`}
              style={{ color: hex(tokens.primary), fontSize: 10, fontWeight: '700', marginLeft: 8 }}
            />
          ) : null}
        </FlexWidget>
        <TextWidget
          text={item.episode.title}
          truncate="END"
          maxLines={1}
          style={{ color: hex(tokens.textPrimary), fontSize: 12, fontWeight: '700', marginTop: 2 }}
        />
      </FlexWidget>
    </FlexWidget>
  );
}

export function WatchNextWidget({ state, labels, tokens, height }: Props) {
  const maxRows = Math.max(1, Math.floor((height - PAD * 2 - HEADER_H + ROW_GAP) / (ROW_H + ROW_GAP)));
  const items = state.status === 'ok' ? state.data.slice(0, Math.min(maxRows, 6)) : [];

  return (
    <FlexWidget
      style={{
        flexDirection: 'column',
        height: 'match_parent',
        width: 'match_parent',
        backgroundColor: hex(tokens.background),
        padding: PAD,
      }}
    >
      <FlexWidget
        clickAction="OPEN_URI"
        clickActionData={{ uri: SHOWS_URI }}
        style={{ flexDirection: 'row', alignItems: 'center', height: HEADER_H, width: 'match_parent' }}
      >
        <FlexWidget style={{ flex: 1 }}>
          <TextWidget
            text={labels.watchNext}
            style={{ color: hex(tokens.textPrimary), fontSize: 14, fontWeight: '700' }}
          />
        </FlexWidget>
      </FlexWidget>

      {items.length > 0 ? (
        items.map((it) => (
          <FlexWidget key={it.episode.id} style={{ marginTop: ROW_GAP }}>
            <WatchNextRow item={it} tokens={tokens} />
          </FlexWidget>
        ))
      ) : (
        <FlexWidget
          clickAction={state.status === 'auth' ? 'OPEN_APP' : 'OPEN_URI'}
          clickActionData={state.status === 'auth' ? undefined : { uri: SHOWS_URI }}
          style={{ flex: 1, alignItems: 'center', justifyContent: 'center', width: 'match_parent' }}
        >
          <TextWidget
            text={state.status === 'auth' ? labels.signIn : labels.emptyWatchNext}
            style={{ color: hex(state.status === 'auth' ? tokens.primary : tokens.textMuted), fontSize: 12, fontWeight: '500' }}
          />
        </FlexWidget>
      )}
    </FlexWidget>
  );
}
