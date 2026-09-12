import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ExternalLink, Link2, PauseCircle, PlayCircle, UploadCloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { EditorialDisclosure } from './editorial-disclosure';
import { api, post } from '../api';
import { addDays, localDate } from '../../../../packages/editorial/src/index';

type Publication = {
  id: string;
  shortId: string;
  state: string;
  publishAt: string;
  videoId: string | null;
  uploadedBytes: string;
  bytes: string;
  errorMessage: string | null;
  lastVerifiedAt: string | null;
  cancelRequested: boolean;
  metadata: { title: string; description: string };
};
type Slot = {
  id: string;
  plannedAt: string;
  role: string;
  short: { id: string; title: string; description: string; hashtags: string[] } | null;
  slate: { localDate: string; timezone: string };
};
type Overview = {
  configured: boolean;
  connection: {
    channelId: string;
    title: string;
    avatar: string | null;
    subscribers: string | null;
    state: string;
    publishingPaused: boolean;
  } | null;
  publications: Publication[];
  slots: Slot[];
  campaigns: Array<{ id: string; startDate: string; endDate: string; timezone: string }>;
};

export function YouTubePanel({ date, timezone }: { date: string; timezone: string }) {
  const [data, setData] = useState<Overview | null>(null),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState<string | null>(null),
    [start, setStart] = useState(''),
    [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () =>
      void api<Overview>('/youtube')
        .then((d) => {
          if (active) setData(d);
        })
        .catch((e: Error) => {
          if (active) setError(e.message);
        });
    load();
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  async function act(path: string, body?: unknown, action = path) {
    setBusy(action);
    setError('');
    setMessage('');
    try {
      const result = await post<{ url?: string; message?: string }>(path, body);
      if (result.url) {
        window.location.assign(result.url);
        return;
      }
      setData(await api<Overview>('/youtube'));
      setMessage(result.message ?? 'Request saved. The worker will verify the result.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const connectResult = new URLSearchParams(window.location.search).get('youtube');
  if (!data)
    return (
      <section aria-label="YouTube publishing">
        <p role="status">{error || 'Loading publishing status…'}</p>
      </section>
    );
  const connection = data.connection;
  const selected = data.slots.filter((s) => s.slate.localDate === date);
  const publications = data.publications.filter(
    (p) => localDate(new Date(p.publishAt), timezone) === date,
  );
  return (
    <section
      className="youtube-workspace"
      aria-labelledby="youtube-title"
      data-keyboard={keyboard}
      onKeyDownCapture={() => setKeyboard(true)}
      onPointerDownCapture={() => setKeyboard(false)}
    >
      <div className="section-heading">
        <div>
          <h2 id="youtube-title">From your slate to YouTube.</h2>
          <p>Upload privately. Schedule deliberately. Verify what actually happens.</p>
        </div>
        <Badge
          variant="outline"
          className={
            connection?.state === 'CONNECTED'
              ? 'publication-status publication-status-success'
              : 'publication-status publication-status-warning'
          }
        >
          {connection?.state === 'CONNECTED' ? 'Channel connected' : 'Connection required'}
        </Badge>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {message && (
        <div className="publication-feedback" role="status">
          <Check aria-hidden="true" />
          {message}
        </div>
      )}
      {connectResult && (
        <p role="status">
          {connectResult === 'connected'
            ? 'YouTube channel connected.'
            : connectResult === 'denied'
              ? 'Connection was cancelled.'
              : 'Connection failed. Check configuration and reconnect the original channel if uploads are pending.'}
        </p>
      )}
      <div className="youtube-connection">
        <div className="youtube-channel">
          {connection && (
            <Avatar size="lg">
              {connection.avatar && <AvatarImage src={connection.avatar} alt="" />}
              <AvatarFallback aria-hidden="true">
                {connection.title.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          )}
          <div>
            <strong>{connection?.title ?? 'Connect your channel'}</strong>
            <p>
              {connection
                ? `${connection.channelId}${connection.subscribers ? ` · ${connection.subscribers} subscribers` : ''}`
                : 'Your Google password is never stored. Access can be revoked at any time.'}
            </p>
          </div>
        </div>
        <div className="youtube-actions">
          <Button
            disabled={Boolean(busy) || !data.configured}
            aria-busy={busy === 'connect'}
            onClick={() => void act('/youtube/connect', undefined, 'connect')}
          >
            <Link2 data-icon="inline-start" />
            {busy === 'connect'
              ? 'Opening Google…'
              : connection
                ? 'Reconnect channel'
                : 'Connect YouTube'}
          </Button>
          {connection && (
            <Button
              variant={connection.publishingPaused ? 'secondary' : 'outline'}
              disabled={Boolean(busy)}
              aria-busy={busy === 'publishing-pause'}
              onClick={() =>
                void (async () => {
                  setBusy('publishing-pause');
                  setError('');
                  setMessage('');
                  try {
                    await api('/youtube/publishing', {
                      method: 'PATCH',
                      body: JSON.stringify({ paused: !connection.publishingPaused }),
                    });
                    setData(await api<Overview>('/youtube'));
                    setMessage(
                      connection.publishingPaused
                        ? 'Publishing resumed. Pending work can continue.'
                        : 'Publishing paused. Existing remote schedules remain on YouTube.',
                    );
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(null);
                  }
                })()
              }
            >
              {connection.publishingPaused ? (
                <PlayCircle data-icon="inline-start" />
              ) : (
                <PauseCircle data-icon="inline-start" />
              )}
              {connection.publishingPaused ? 'Resume publishing' : 'Pause publishing'}
            </Button>
          )}
          {connection && (
            <Button
              variant="outline"
              disabled={Boolean(busy)}
              aria-busy={busy === 'disconnect'}
              onClick={() => void act('/youtube/disconnect', undefined, 'disconnect')}
            >
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          )}
        </div>
      </div>
      {!data.configured && (
        <Alert>
          <AlertDescription>
            Live publishing is disabled. Configure YOUTUBE_MODE=live, Google OAuth credentials and
            YOUTUBE_TOKEN_KEY on the server.
          </AlertDescription>
        </Alert>
      )}
      <p className="muted">
        Disconnecting does not cancel existing YouTube schedules. Cancel and verify them first, or
        manage them in YouTube Studio.
      </p>
      {connection?.publishingPaused && (
        <Alert>
          <AlertDescription>
            Publishing is paused. New uploads and pending publication work will not advance until
            you resume. Existing remote YouTube schedules are not deleted automatically.
          </AlertDescription>
        </Alert>
      )}
      <EditorialDisclosure title={`Publish reserved Shorts · ${date || 'select a day'}`}>
        {!selected.length && !publications.length && (
          <p>No reserved Shorts for this date. Plan a future day above, then approve its Shorts.</p>
        )}
        {selected
          .filter(
            (s) =>
              !data.publications.some((p) => p.shortId === s.short?.id && p.state !== 'CANCELLED'),
          )
          .map((slot) => (
            <ScheduleForm
              key={slot.id}
              slot={slot}
              disabled={
                Boolean(busy) ||
                !data.configured ||
                connection?.state !== 'CONNECTED' ||
                connection.publishingPaused
              }
              pending={busy === `schedule:${slot.id}`}
              schedule={(body) => act('/youtube/publications', body, `schedule:${slot.id}`)}
            />
          ))}
        {publications.map((p) => (
          <article className="publication-row" key={p.id}>
            <div className="section-heading">
              <div>
                <Link to={`/shorts/${p.shortId}`}>
                  <strong>{p.metadata.title}</strong>
                </Link>
                <p>
                  {new Date(p.publishAt).toLocaleString(undefined, { timeZone: timezone })} ·{' '}
                  {timezone}
                </p>
              </div>
              <Badge
                variant="secondary"
                className={publicationStatusClass(p)}
                aria-live="polite"
                aria-atomic="true"
              >
                {p.cancelRequested
                  ? 'Cancellation pending'
                  : p.state.replaceAll('_', ' ').toLowerCase()}
              </Badge>
            </div>
            <p aria-live="polite" aria-atomic="true">
              {p.state === 'UPLOADING'
                ? `${Math.round((Number(p.uploadedBytes) / Number(p.bytes)) * 100)}% uploaded`
                : p.lastVerifiedAt
                  ? `Last verified ${new Date(p.lastVerifiedAt).toLocaleString()}`
                  : 'Not yet verified by YouTube'}
            </p>
            {p.errorMessage && (
              <Alert variant="destructive">
                <AlertDescription>{p.errorMessage}</AlertDescription>
              </Alert>
            )}
            <p className="publication-description">{p.metadata.description}</p>
            <div className="youtube-actions">
              {['NEEDS_ATTENTION', 'MISSED', 'FAILED'].includes(p.state) && (
                <Button
                  variant="outline"
                  disabled={Boolean(busy) || !connection}
                  aria-busy={busy === `retry:${p.id}`}
                  onClick={() =>
                    void act(`/youtube/publications/${p.id}/retry`, undefined, `retry:${p.id}`)
                  }
                >
                  {busy === `retry:${p.id}` ? 'Checking…' : 'Check and retry'}
                </Button>
              )}
              {!['PUBLISHED', 'CANCELLED'].includes(p.state) && (
                <Button
                  variant="outline"
                  disabled={Boolean(busy) || !connection || p.cancelRequested}
                  aria-busy={busy === `cancel:${p.id}`}
                  onClick={() =>
                    void act(`/youtube/publications/${p.id}/cancel`, undefined, `cancel:${p.id}`)
                  }
                >
                  {busy === `cancel:${p.id}` ? 'Cancelling…' : 'Cancel schedule'}
                </Button>
              )}
              {p.videoId && (
                <Button asChild variant="ghost">
                  <a
                    href={`https://studio.youtube.com/video/${encodeURIComponent(p.videoId)}/edit`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    YouTube Studio
                    <ExternalLink data-icon="inline-end" />
                  </a>
                </Button>
              )}
            </div>
          </article>
        ))}
      </EditorialDisclosure>
      <EditorialDisclosure title="30-day campaign · 90 Shorts">
        <p>
          Creates editorial planning requests for 30 days. It does not authorize uploads; schedule
          each reviewed Short explicitly.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act('/youtube/campaigns', { startDate: start }, 'campaign');
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="campaign-start">Start date</FieldLabel>
              <Input
                id="campaign-start"
                type="date"
                required
                value={start}
                onChange={(event) => setStart(event.target.value)}
              />
            </Field>
            <Button
              disabled={Boolean(busy) || !start}
              aria-busy={busy === 'campaign'}
              type="submit"
            >
              {busy === 'campaign' ? 'Creating campaign…' : 'Create campaign'}
            </Button>
          </FieldGroup>
        </form>
        {data.campaigns.map((c) => {
          const days = Array.from({ length: 30 }, (_, index) => addDays(c.startDate, index));
          const owned = data.publications.filter((p) =>
            days.includes(localDate(new Date(p.publishAt), c.timezone)),
          );
          const published = owned.filter((p) => p.state === 'PUBLISHED').length,
            scheduled = owned.filter((p) => p.state === 'SCHEDULED').length;
          const ready = data.slots.filter(
            (s) =>
              days.includes(s.slate.localDate) &&
              !data.publications.some((p) => p.shortId === s.short?.id && p.state !== 'CANCELLED'),
          ).length;
          return (
            <article className="campaign-summary" key={c.id}>
              <h3>
                {c.startDate} – {c.endDate}
              </h3>
              <p>
                Goal 90 · Published {published} · Scheduled {scheduled} · Reserved {ready} · Missing{' '}
                {Math.max(0, 90 - published - scheduled - ready)}
              </p>
              <p>
                Current coverage{' '}
                {Math.min(100, Math.round(((published + scheduled + ready) / 90) * 100))}% — not a
                prediction. {days.filter((d) => d >= localDate(new Date(), c.timezone)).length} days
                remaining.
              </p>
              <div className="campaign-grid">
                {days.map((day) => {
                  const count = owned.filter(
                    (p) =>
                      localDate(new Date(p.publishAt), c.timezone) === day &&
                      ['PUBLISHED', 'SCHEDULED'].includes(p.state),
                  ).length;
                  return (
                    <div key={day}>
                      <time>{day.slice(5)}</time>
                      <span>{count}/3 verified</span>
                    </div>
                  );
                })}
              </div>
            </article>
          );
        })}
      </EditorialDisclosure>
    </section>
  );
}

function ScheduleForm({
  slot,
  disabled,
  pending,
  schedule,
}: {
  slot: Slot;
  disabled: boolean;
  pending: boolean;
  schedule: (body: unknown) => Promise<void>;
}) {
  const [kids, setKids] = useState(''),
    [synthetic, setSynthetic] = useState('');
  return (
    <form
      className="publication-row"
      onSubmit={(event) => {
        event.preventDefault();
        void schedule({
          slotId: slot.id,
          madeForKids: kids === 'yes',
          containsSyntheticMedia: synthetic === 'yes',
          confirm: true,
        });
      }}
    >
      <h3>{slot.short?.title}</h3>
      <p>
        {slot.role.toLowerCase()} ·{' '}
        {new Date(slot.plannedAt).toLocaleString(undefined, { timeZone: slot.slate.timezone })} ·{' '}
        {slot.slate.timezone}
      </p>
      <p className="publication-description">{slot.short?.description}</p>
      <p>{slot.short?.hashtags.join(' ')}</p>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`kids-${slot.id}`}>Is this video made for kids?</FieldLabel>
          <select
            id={`kids-${slot.id}`}
            required
            value={kids}
            onChange={(e) => setKids(e.target.value)}
          >
            <option value="">Choose audience</option>
            <option value="yes">Yes, made for kids</option>
            <option value="no">No, not made for kids</option>
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`synthetic-${slot.id}`}>
            Does it contain realistic altered or synthetic content requiring disclosure?
          </FieldLabel>
          <select
            id={`synthetic-${slot.id}`}
            required
            value={synthetic}
            onChange={(e) => setSynthetic(e.target.value)}
          >
            <option value="">Choose disclosure</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </Field>
      </FieldGroup>
      <p>
        Scheduling authorizes this Short to become public at the time shown. Its content is locked
        while the publication is active.
      </p>
      <div className="youtube-actions">
        <Button type="submit" disabled={disabled || !kids || !synthetic} aria-busy={pending}>
          <UploadCloud data-icon="inline-start" />
          {pending ? 'Reserving upload…' : 'Upload and schedule'}
        </Button>
        <Button asChild variant="ghost">
          <Link to={`/shorts/${slot.short?.id}`}>Review metadata</Link>
        </Button>
      </div>
    </form>
  );
}

function publicationStatusClass(publication: Publication) {
  if (publication.cancelRequested) return 'publication-status publication-status-warning';
  if (['PUBLISHED', 'SCHEDULED'].includes(publication.state))
    return 'publication-status publication-status-success';
  if (['NEEDS_ATTENTION', 'MISSED', 'FAILED'].includes(publication.state))
    return 'publication-status publication-status-danger';
  if (publication.state === 'CANCELLED') return 'publication-status publication-status-muted';
  return 'publication-status publication-status-progress';
}
