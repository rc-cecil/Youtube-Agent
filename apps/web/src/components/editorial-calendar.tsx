import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, post } from '../api.js';
import { CalendarDays, WandSparkles, ShieldCheck } from 'lucide-react';
import { EditorialDisclosure } from './editorial-disclosure.js';
import { YouTubePanel } from './youtube-panel.js';
import {
  addDays,
  localDate,
  roles,
  type EditorialConfig,
} from '../../../../packages/editorial/src/index.js';
type Slot = {
  id: string;
  role: string;
  localTime: string;
  reason: string;
  score: number | null;
  short: {
    id: string;
    title: string;
    sourceId: string;
    game: string;
    duration: number;
    state: string;
  } | null;
};
type Overview = {
  slates: Array<{
    localDate: string;
    timezone: string;
    revision: number;
    slots: Slot[];
    diagnostics: { eligible: number; considered: number; duplicate?: number };
  }>;
  runs: Array<{
    id: string;
    localDate: string;
    state: string;
    attempt: number;
    errorMessage: string | null;
  }>;
  ready: number;
  reserved: number;
  missing: number;
  daysOfBuffer: number;
  sources: Array<{ id: string; filename: string; _count: { shorts: number } }>;
};
export function EditorialCalendar() {
  const [data, setData] = useState<Overview | null>(null),
    [settings, setSettings] = useState<EditorialConfig | null>(null);
  const [date, setDate] = useState(''),
    [anchor, setAnchor] = useState(''),
    [days, setDays] = useState(7),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const refresh = async () => setData(await api<Overview>('/editorial'));
  useEffect(() => {
    let active = true;
    void api<EditorialConfig>('/settings/editorial')
      .then((s) => {
        if (active) {
          setSettings(s);
          setDate(localDate(new Date(), s.timezone));
          setAnchor(localDate(new Date(), s.timezone));
        }
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    const load = () => {
      void api<Overview>('/editorial')
        .then((d) => {
          if (active) setData(d);
        })
        .catch((e: Error) => {
          if (active) setError(e.message);
        });
    };
    load();
    const timer = setInterval(load, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  async function action(save = false) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (save)
        await api('/settings/editorial', { method: 'PATCH', body: JSON.stringify(settings) });
      else await post('/editorial/plan', { date });
      await refresh();
      setNotice(
        save
          ? 'Settings saved. Replan future days to apply the checks.'
          : 'Planning queued. Assignments appear here when checks finish.',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const selected = data?.slates.find((s) => s.localDate === date),
    run = data?.runs.find((r) => r.localDate === date);
  const running = run && ['PENDING', 'RUNNING', 'RETRYING'].includes(run.state);
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Give every moment its place.</h1>
          <p>
            Three different jobs each day. Your strongest eligible concept gets first choice for
            HERO.
          </p>
        </div>
        <Link className="button secondary" to="/shorts">
          <CalendarDays size={16} />
          Review Shorts
        </Link>
      </header>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!settings || !data ? (
        <p role="status">Loading your editorial workspace…</p>
      ) : (
        <>
          <div className="editorial-summary">
            <span>
              <strong>{data.reserved}</strong> reserved
            </span>
            <span>
              <strong>{data.ready}</strong> approved, unassigned
            </span>
            <span>
              <strong>{data.daysOfBuffer}</strong> days reserved
            </span>
            <span>
              <strong>{data.missing}</strong> missing planned slots
            </span>
          </div>
          <p>
            Reservations are not publications. Review and schedule them in YouTube publishing below.
            Times use {settings.timezone}.
          </p>
          <div className="editorial-toolbar">
            <label>
              Day
              <input
                type="date"
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  setAnchor(e.target.value);
                }}
              />
            </label>
            <div className="editorial-view-group">
              <span>Calendar view</span>
              <div
                className="editorial-view-switch"
                role="group"
                aria-label="Calendar view"
                data-month={days === 30}
              >
                <span aria-hidden="true" className="editorial-view-indicator" />
                {[7, 30].map((value) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={days === value}
                    onClick={() => setDays(value)}
                  >
                    {value} days
                  </button>
                ))}
              </div>
            </div>
            <button
              className="button primary"
              disabled={busy || Boolean(running) || !date}
              onClick={() => void action()}
            >
              <WandSparkles size={16} aria-hidden="true" />
              {running ? 'Planning…' : selected ? 'Replan this day' : 'Plan this day'}
            </button>
          </div>
          {run && (
            <p role="status">
              Latest plan: {run.state.toLowerCase()} · attempt {run.attempt}
              {run.errorMessage ? ` · ${run.errorMessage}` : ''}
            </p>
          )}
          {selected && (
            <p>
              {selected.diagnostics.eligible} eligible of {selected.diagnostics.considered}{' '}
              considered · {selected.diagnostics.duplicate ?? 0} blocked duplicates · revision{' '}
              {selected.revision}
            </p>
          )}
          <div className="editorial-slots">
            {roles.map((role, i) => {
              const slot = selected?.slots.find((s) => s.role === role);
              return (
                <section
                  className="editorial-slot"
                  data-role={role.toLowerCase()}
                  data-filled={Boolean(slot?.short)}
                  key={role}
                  aria-label={role}
                >
                  <header>
                    <h2>{role.charAt(0) + role.slice(1).toLowerCase()}</h2>
                    <time>{slot?.localTime ?? settings.postingTimes[i]}</time>
                  </header>
                  {role === 'HERO' && (
                    <span className="editorial-protected">
                      <ShieldCheck size={14} aria-hidden="true" />
                      First choice, protected
                    </span>
                  )}
                  {slot?.short ? (
                    <>
                      <Link to={`/shorts/${slot.short.id}`}>
                        <img src={`/api/sources/${slot.short.sourceId}/assets/thumbnail`} alt="" />
                        <h3>{slot.short.title}</h3>
                      </Link>
                      <p>
                        {slot.short.game} · {Math.round(slot.short.duration)}s ·{' '}
                        {slot.short.state.toLowerCase()}
                      </p>
                      <p>Role score {slot.score?.toFixed(1)}</p>
                    </>
                  ) : (
                    <h3>{selected ? 'Missing Short' : 'Not planned yet'}</h3>
                  )}
                  <p>
                    {slot?.reason ??
                      [
                        'Accessible action with a fast payoff.',
                        'A moment that invites comments, shares, or reactions.',
                        'The strongest eligible concept, reserved first.',
                      ][i]}
                  </p>
                  {!slot?.short && <Link to="/shorts">Review available Shorts</Link>}
                </section>
              );
            })}
          </div>
          <section className="panel editorial-horizon">
            <h2>Content calendar</h2>
            <div className="editorial-days">
              {anchor &&
                Array.from({ length: days }, (_, i) => {
                  const day = addDays(anchor, i),
                    slate = data.slates.find((s) => s.localDate === day),
                    count = slate?.slots.filter((s) => s.short).length ?? 0;
                  return (
                    <button
                      key={day}
                      className="editorial-day"
                      aria-pressed={date === day}
                      onClick={() => setDate(day)}
                      aria-label={`${day}, ${count} of 3 reserved`}
                    >
                      <time>{day.slice(5)}</time>
                      <span>{count}/3 reserved</span>
                      <small>
                        {slate ? (count === 3 ? 'Complete' : 'Needs content') : 'Not planned'}
                      </small>
                    </button>
                  );
                })}
            </div>
          </section>
          <EditorialDisclosure title="Editorial settings">
            <p>Saving invalidates future reservations so changed rules can be checked together.</p>
            <div className="editorial-fields">
              <label>
                Timezone
                <input
                  value={settings.timezone}
                  onChange={(e) => setSettings({ ...settings, timezone: e.target.value })}
                />
              </label>
              {roles.map((r, i) => (
                <label key={r}>
                  {r.toLowerCase()} time
                  <input
                    type="time"
                    value={settings.postingTimes[i]}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        postingTimes: settings.postingTimes.map((t, j) =>
                          j === i ? e.target.value : t,
                        ),
                      })
                    }
                  />
                </label>
              ))}
              <label>
                Maximum adjacent similarity
                <input
                  type="number"
                  min={0.3}
                  max={0.99}
                  step={0.01}
                  value={settings.similarityThreshold}
                  onChange={(e) =>
                    setSettings({ ...settings, similarityThreshold: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                Maximum Shorts per source per day
                <input
                  type="number"
                  min={1}
                  max={3}
                  value={settings.maxSourcePerDay}
                  onChange={(e) =>
                    setSettings({ ...settings, maxSourcePerDay: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                Source spacing (minutes)
                <input
                  type="number"
                  min={0}
                  max={1440}
                  value={settings.sourceCooldownMinutes}
                  onChange={(e) =>
                    setSettings({ ...settings, sourceCooldownMinutes: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                Buffer target (days)
                <input
                  type="number"
                  min={3}
                  max={7}
                  value={settings.bufferDays}
                  onChange={(e) => setSettings({ ...settings, bufferDays: Number(e.target.value) })}
                />
              </label>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={settings.automaticPlanning}
                onChange={(e) => setSettings({ ...settings, automaticPlanning: e.target.checked })}
              />
              Automatically maintain plans before the first slot
            </label>
            <button className="button primary" disabled={busy} onClick={() => void action(true)}>
              Save editorial settings
            </button>
          </EditorialDisclosure>
          <YouTubePanel date={date} timezone={settings.timezone} />
          <EditorialDisclosure title="Source distribution">
            {data.sources.map((s) => (
              <p key={s.id}>
                <Link to={`/library/${s.id}`}>{s.filename}</Link> · {s._count.shorts} Shorts created
              </p>
            ))}
          </EditorialDisclosure>
        </>
      )}
    </>
  );
}
export function ReuseDeclaration({
  id,
  initial,
}: {
  id: string;
  initial: { reuseKind: string | null; reuseOfId: string | null; reuseReason: string | null };
}) {
  const [kind, setKind] = useState(initial.reuseKind ?? ''),
    [related, setRelated] = useState(initial.reuseOfId ?? ''),
    [reason, setReason] = useState(initial.reuseReason ?? ''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <EditorialDisclosure title="Intentional related edit">
      <p>
        Declare a replay, part two, or alternate edit. This exempts only the related pair from
        moment checks. Identical files and adjacent similarity remain blocked.
      </p>
      <label>
        Edit type
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">No exception</option>
          <option>REPLAY</option>
          <option>PART_2</option>
          <option>ALTERNATE_EDIT</option>
        </select>
      </label>
      <label>
        Related Short ID
        <input value={related} onChange={(e) => setRelated(e.target.value)} />
      </label>
      <label>
        Editorial justification
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </label>
      <button
        className="button secondary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void api(`/shorts/${id}/reuse`, {
            method: 'PATCH',
            body: JSON.stringify({
              kind: kind || null,
              relatedShortId: kind ? related : null,
              reason,
            }),
          })
            .then(() => setMessage('Declaration saved. Replan affected days.'))
            .catch((e: Error) => setMessage(e.message))
            .finally(() => setBusy(false));
        }}
      >
        Save declaration
      </button>
      <p role="status">{message}</p>
    </EditorialDisclosure>
  );
}
