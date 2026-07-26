import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { dismissAllDialogs, showDialog } from '../lib/dialog';
import { T } from './primitives';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing } from '../theme/theme';

export interface FilterPickerOption {
  value: string;
  label: string;
}

interface OptionRowProps {
  option: FilterPickerOption;
  selected: boolean;
  onPress: () => void;
}

/** One selectable row inside a picker dialog (checkmark reflects the selection). */
function OptionRow({ option, selected, onPress }: OptionRowProps) {
  const { tokens } = useAppearance();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: tokens.surfaceElevated, opacity: pressed ? 0.85 : 1 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={option.label}
    >
      <T variant="body" style={styles.rowLabel} numberOfLines={1}>
        {option.label}
      </T>
      <Ionicons
        name={selected ? 'checkmark-circle' : 'ellipse-outline'}
        size={20}
        color={selected ? tokens.primary : tokens.textMuted}
      />
    </Pressable>
  );
}

interface MultiSelectContentProps {
  options: FilterPickerOption[];
  initial: string[];
  /** Reports the pending selection on every toggle (applied by the dialog's Done). */
  onPending: (values: string[]) => void;
}

/** Multi-select dialog body: toggles accumulate locally until Done applies them. */
function MultiSelectContent({ options, initial, onPending }: MultiSelectContentProps) {
  const [pending, setPending] = useState<string[]>(initial);
  const toggle = (value: string) => {
    const next = pending.includes(value)
      ? pending.filter((v) => v !== value)
      : [...pending, value];
    setPending(next);
    onPending(next);
  };
  return (
    <View style={styles.rows}>
      {options.map((o) => (
        <OptionRow
          key={o.value}
          option={o}
          selected={pending.includes(o.value)}
          onPress={() => toggle(o.value)}
        />
      ))}
    </View>
  );
}

interface FilterPickerProps {
  /** Row label, e.g. t('explore:filters.genre'). */
  label: string;
  /** Current selection rendered inline (e.g. "Drama", "3", or the "all" placeholder). */
  valueLabel: string;
  /** Highlights the pill when a non-default selection is active. */
  active?: boolean;
  dialogTitle: string;
  options: FilterPickerOption[];
  /** Checkmarked rows in the dialog. */
  selected: string[];
  /** Multi-select: toggles + Done; single-select: tap applies and dismisses. */
  multi?: boolean;
  onChange: (values: string[]) => void;
}

/**
 * Dropdown-style filter row ("Label: value ⌄") that opens the shared dialog
 * system with a single- or multi-select option list.
 */
export function FilterPicker({
  label,
  valueLabel,
  active,
  dialogTitle,
  options,
  selected,
  multi,
  onChange,
}: FilterPickerProps) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['common']);

  const open = () => {
    if (multi) {
      let pending = selected;
      showDialog({
        title: dialogTitle,
        content: (
          <MultiSelectContent
            options={options}
            initial={selected}
            onPending={(values) => {
              pending = values;
            }}
          />
        ),
        buttons: [
          { label: t('common:done'), variant: 'primary', onPress: () => onChange(pending) },
          { label: t('common:cancel'), variant: 'ghost' },
        ],
      });
      return;
    }
    showDialog({
      title: dialogTitle,
      content: (
        <View style={styles.rows}>
          {options.map((o) => (
            <OptionRow
              key={o.value}
              option={o}
              selected={selected.includes(o.value)}
              onPress={() => {
                onChange([o.value]);
                dismissAllDialogs();
              }}
            />
          ))}
        </View>
      ),
      buttons: [{ label: t('common:cancel'), variant: 'ghost' }],
    });
  };

  return (
    <Pressable
      onPress={open}
      style={({ pressed }) => [
        styles.picker,
        { backgroundColor: active ? tokens.primary : tokens.chip, opacity: pressed ? 0.85 : 1 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${valueLabel}`}
    >
      <T
        variant="caption"
        style={{ color: active ? tokens.primaryForeground : tokens.textMuted }}
        numberOfLines={1}
      >
        {label}: {valueLabel}
      </T>
      <Ionicons
        name="chevron-forward"
        size={14}
        color={active ? tokens.primaryForeground : tokens.textMuted}
        style={styles.chevron}
      />
    </Pressable>
  );
}

interface FilterToggleProps {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}

/** Pill-style on/off filter (no dialog) — e.g. the Hide anime toggle. */
export function FilterToggle({ label, value, onChange }: FilterToggleProps) {
  const { tokens } = useAppearance();
  return (
    <Pressable
      onPress={() => onChange(!value)}
      style={({ pressed }) => [
        styles.picker,
        { backgroundColor: value ? tokens.primary : tokens.chip, opacity: pressed ? 0.85 : 1 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ checked: value }}
    >
      <T
        variant="caption"
        style={{ color: value ? tokens.primaryForeground : tokens.textMuted }}
        numberOfLines={1}
      >
        {label}
      </T>
      <Ionicons
        name={value ? 'checkmark-circle' : 'ellipse-outline'}
        size={14}
        color={value ? tokens.primaryForeground : tokens.textMuted}
        style={styles.chevron}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  picker: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginRight: spacing.sm,
  },
  chevron: { marginLeft: spacing.xs },
  rows: { gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  rowLabel: { flex: 1, marginRight: spacing.sm },
});
