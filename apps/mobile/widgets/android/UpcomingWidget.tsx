import React from 'react';
import { FlexWidget, TextWidget, ImageWidget } from 'react-native-android-widget';
import type { Tokens, UpcomingGroupDto, UpcomingItemDto } from '@tvwatch/shared';
import {
  EPISODE_URI,
  SHOWS_URI,
  episodeCode,
  shortAirDate,
  upcomingGroupTitle,
  type WidgetLabels,
  type WidgetFetchState,
} from '../data';

const hex = (c: string) => c as `#${string}`;
const img = (u: string) => u as React.ComponentProps<typeof ImageWidget>['image'];

const ROW_H = 68;
const ROW_GAP = 6;
const GROUP_H = 22;
const HEADER_H = 26;
const PAD = 12;
const MAX_PER_GROUP = 3;

interface Props {
  state: WidgetFetchState<UpcomingGroupDto[]>;
  labels: WidgetLabels;
  tokens: Tokens;
  height: number;
}

function UpcomingRow({ item, tokens }: { item: UpcomingItemDto; tokens: Tokens }) {
  const dateLabel = shortAirDate(item.airDate);
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri: EPISODE_URI(item.id) }}
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
      {item.posterUrl ? (
        <ImageWidget
          image={img(item.posterUrl)}
          imageWidth={37}
          imageHeight={56}
          radius={6}
          resizeMode="cover"
          style={{ width: 37, height: 56, marginRight: 10 }}
        />
      ) : null}
      <FlexWidget style={{ flexDirection: 'column', flex: 1 }}>
        <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent' }}>
          <FlexWidget style={{ flex: 1 }}>
            <TextWidget
              text={item.title}
              truncate="END"
              maxLines={1}
              style={{ color: hex(tokens.textPrimary), fontSize: 12, fontWeight: '700' }}
            />
          </FlexWidget>
          {item.label ? (
            <TextWidget
              text={item.label}
              style={{
                color: hex(tokens.primaryForeground),
                fontSize: 8,
                fontWeight: '700',
                backgroundColor: hex(tokens.primary),
                borderRadius: 6,
                paddingHorizontal: 5,
                paddingVertical: 1,
                marginLeft: 6,
              }}
            />
          ) : null}
        </FlexWidget>
        <TextWidget
          text={`${episodeCode(item.seasonNumber, item.episodeNumber)} · ${item.episodeTitle ?? ''}`}
          truncate="END"
          maxLines={1}
          style={{ color: hex(tokens.textMuted), fontSize: 10, fontWeight: '500', marginTop: 2 }}
        />
        <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2, width: 'match_parent' }}>
          <FlexWidget style={{ flex: 1 }}>
            <TextWidget
              text={`${dateLabel}${item.airTime ? ` · ${item.airTime}` : ''}`}
              truncate="END"
              maxLines={1}
              style={{ color: hex(tokens.textMuted), fontSize: 10 }}
            />
          </FlexWidget>
          {item.network ? (
            <TextWidget
              text={item.network}
              maxLines={1}
              style={{ color: hex(tokens.primary), fontSize: 9, fontWeight: '700', marginLeft: 6 }}
            />
          ) : null}
        </FlexWidget>
      </FlexWidget>
    </FlexWidget>
  );
}

type FlatRow =
  | { type: 'header'; key: string; title: string }
  | { type: 'item'; key: string; item: UpcomingItemDto };

export function UpcomingWidget({ state, labels, tokens, height }: Props) {
  // Fill the available dp height: groups render only when their header + first row fit.
  let budget = height - PAD * 2 - HEADER_H - 6;
  const rows: FlatRow[] = [];
  if (state.status === 'ok') {
    for (const g of state.data) {
      if (budget < GROUP_H + ROW_H + ROW_GAP) break;
      rows.push({ type: 'header', key: `h_${g.key}`, title: upcomingGroupTitle(g.key, labels, g.label) });
      budget -= GROUP_H;
      for (const it of g.items.slice(0, MAX_PER_GROUP)) {
        if (budget < ROW_H + ROW_GAP) break;
        rows.push({ type: 'item', key: `c_${it.id}`, item: it });
        budget -= ROW_H + ROW_GAP;
      }
    }
  }

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
            text={labels.upcoming}
            style={{ color: hex(tokens.textPrimary), fontSize: 14, fontWeight: '700' }}
          />
        </FlexWidget>
      </FlexWidget>

      {rows.length > 0 ? (
        rows.map((r) =>
          r.type === 'header' ? (
            <FlexWidget key={r.key} style={{ height: GROUP_H, justifyContent: 'flex-end' }}>
              <TextWidget
                text={r.title.toUpperCase()}
                style={{ color: hex(tokens.textMuted), fontSize: 10, fontWeight: '700', letterSpacing: 1 }}
              />
            </FlexWidget>
          ) : (
            <FlexWidget key={r.key} style={{ marginTop: ROW_GAP }}>
              <UpcomingRow item={r.item} tokens={tokens} />
            </FlexWidget>
          ),
        )
      ) : (
        <FlexWidget
          clickAction={state.status === 'auth' ? 'OPEN_APP' : 'OPEN_URI'}
          clickActionData={state.status === 'auth' ? undefined : { uri: SHOWS_URI }}
          style={{ flex: 1, alignItems: 'center', justifyContent: 'center', width: 'match_parent' }}
        >
          <TextWidget
            text={state.status === 'auth' ? labels.signIn : labels.emptyUpcoming}
            style={{ color: hex(state.status === 'auth' ? tokens.primary : tokens.textMuted), fontSize: 12, fontWeight: '500' }}
          />
        </FlexWidget>
      )}
    </FlexWidget>
  );
}
