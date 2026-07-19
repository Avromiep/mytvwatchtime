'use client';

import { useMemo, useState } from 'react';

/**
 * Friendly schedule editor: builds a 5-field cron from plain-English choices so admins
 * never have to read cron syntax. "Custom cron" stays available for advanced cases.
 * The resulting cron string is always shown for transparency.
 */

const TIMEZONES = [
  { value: '', label: 'Server default' },
  { value: 'UTC', label: 'UTC' },
  { value: 'Europe/Rome', label: 'Europe/Rome' },
  { value: 'Europe/Paris', label: 'Europe/Paris' },
  { value: 'Europe/London', label: 'Europe/London' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin' },
  { value: 'America/New_York', label: 'America/New_York' },
  { value: 'America/Chicago', label: 'America/Chicago' },
  { value: 'America/Denver', label: 'America/Denver' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo' },
  { value: 'Asia/Shanghai', label: 'Asia/Shanghai' },
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney' },
];

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type Freq = '5min' | '15min' | '30min' | 'hourly' | '6h' | '12h' | 'daily' | 'weekly' | 'custom';

const FREQ_TO_CRON: Partial<Record<Freq, string>> = {
  '5min': '*/5 * * * *',
  '15min': '*/15 * * * *',
  '30min': '*/30 * * * *',
  hourly: '0 * * * *',
  '6h': '0 */6 * * *',
  '12h': '0 */12 * * *',
};

function parseCron(cron: string): { freq: Freq; time: string; weekday: number } {
  const fallback = { freq: 'custom' as Freq, time: '06:00', weekday: 1 };
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return fallback;
  const exact = (Object.entries(FREQ_TO_CRON) as [Freq, string][]).find(
    ([, v]) => v === cron.trim(),
  );
  if (exact) return { freq: exact[0], time: '06:00', weekday: 1 };
  const [m, h, dom, mon, dow] = parts;
  const isInt = (s: string) => /^\d+$/.test(s);
  if (isInt(m) && isInt(h) && dom === '*' && mon === '*') {
    const time = `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
    if (dow === '*') return { freq: 'daily', time, weekday: 1 };
    if (isInt(dow)) return { freq: 'weekly', time, weekday: Number(dow) };
  }
  return fallback;
}

function buildCron(freq: Freq, time: string, weekday: number, custom: string): string {
  if (freq === 'custom') return custom.trim();
  const preset = FREQ_TO_CRON[freq];
  if (preset) return preset;
  const [hh, mm] = (time || '06:00').split(':');
  const h = String(Number(hh)),
    m = String(Number(mm));
  return freq === 'daily' ? `${m} ${h} * * *` : `${m} ${h} * * ${weekday}`;
}

const inputCls = 'px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm';
const btnAccent = 'px-3 py-2 bg-accent text-bg font-bold rounded-lg text-sm';
const btnGhost = 'px-3 py-2 bg-surface-alt text-white/60 rounded-lg text-sm';

export function SchedulePicker({
  schedule,
  timezone,
  onSave,
  onCancel,
}: {
  schedule: string;
  timezone?: string | null;
  onSave: (schedule: string, timezone: string | null) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const parsed = useMemo(() => parseCron(schedule), [schedule]);
  const [freq, setFreq] = useState<Freq>(parsed.freq);
  const [time, setTime] = useState(parsed.time);
  const [weekday, setWeekday] = useState(parsed.weekday);
  const [custom, setCustom] = useState(schedule);
  const [tz, setTz] = useState(timezone ?? '');

  const built = buildCron(freq, time, weekday, custom);

  return (
    <div className="mt-4 pt-4 border-t border-border space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs text-white/40 uppercase">Frequency</label>
        <select value={freq} onChange={(e) => setFreq(e.target.value as Freq)} className={inputCls}>
          <option value="5min">Every 5 minutes</option>
          <option value="15min">Every 15 minutes</option>
          <option value="30min">Every 30 minutes</option>
          <option value="hourly">Every hour</option>
          <option value="6h">Every 6 hours</option>
          <option value="12h">Every 12 hours</option>
          <option value="daily">Daily at a time</option>
          <option value="weekly">Weekly</option>
          <option value="custom">Custom cron (advanced)</option>
        </select>
        {freq === 'weekly' ? (
          <select
            value={weekday}
            onChange={(e) => setWeekday(Number(e.target.value))}
            className={inputCls}
          >
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        ) : null}
        {freq === 'daily' || freq === 'weekly' ? (
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className={inputCls}
          />
        ) : null}
        {freq === 'custom' ? (
          <input
            type="text"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="* * * * *"
            className={`${inputCls} w-36`}
          />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs text-white/40 uppercase">Timezone</label>
        <select value={tz} onChange={(e) => setTz(e.target.value)} className={inputCls}>
          {TIMEZONES.map((z) => (
            <option key={z.value} value={z.value}>
              {z.label}
            </option>
          ))}
        </select>
        <span className="text-xs text-white/30">
          → cron: <code className="text-accent">{built || '—'}</code>
          {tz ? ` (${tz})` : ''}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => onSave(built, tz || null)}
          disabled={!built}
          className={`${btnAccent} disabled:opacity-50`}
        >
          Save
        </button>
        {onCancel ? (
          <button onClick={onCancel} className={btnGhost}>
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}
