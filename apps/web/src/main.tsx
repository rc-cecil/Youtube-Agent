import React, { lazy, useEffect, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter,
  NavLink,
  Routes,
  Route,
  Link,
  Navigate,
  useParams,
  useLocation,
} from 'react-router-dom';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronRight,
  Clapperboard,
  Clock3,
  Film,
  FolderOpen,
  LayoutDashboard,
  LogOut,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  UploadCloud,
  X,
  ArrowLeft,
  CircleHelp,
  ScanSearch,
  Gamepad2,
  Play,
  Sparkles,
  WandSparkles,
  CheckCircle2,
} from 'lucide-react';
import type { EditDecisionList } from '../../../packages/remotion/src/edl.js';
import type {
  AiUsageView,
  HighlightScoreView,
  SourceView,
  JobView,
  UploadView,
  ShortSummaryView,
} from '../../../packages/shared/src/index.js';
import { api, post } from './api.js';
import { DashboardHero } from '@/components/dashboard-hero';
import { FuturePreview } from '@/components/future-preview';
import { EditorialCalendar, ReuseDeclaration } from '@/components/editorial-calendar';
import { Button } from '@/components/ui/button';
import { Badge as StatusBadge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Empty as EmptyState,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import './styles.css';
import './editorial-motion.css';

const RemotionPreview = lazy(() => import('@/components/remotion-preview'));

type User = { id: string; email: string };
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong';
const bytes = (value: string | number) => {
  const n = Number(value);
  return n < 1024 ** 2
    ? `${(n / 1024).toFixed(1)} KB`
    : n < 1024 ** 3
      ? `${(n / 1024 ** 2).toFixed(1)} MB`
      : `${(n / 1024 ** 3).toFixed(2)} GB`;
};
const duration = (value: number | null) =>
  value === null
    ? 'Pending'
    : `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
const eventLabel = (value: string) =>
  friendly[value] ??
  value
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
const scoreDimensions: Array<[keyof HighlightScoreView, string]> = [
  ['eventImportance', 'Importance'],
  ['excitement', 'Excitement'],
  ['surprise', 'Surprise'],
  ['skill', 'Skill'],
  ['humor', 'Humor'],
  ['tension', 'Tension'],
  ['emotionalReaction', 'Reaction'],
  ['visualClarity', 'Clarity'],
  ['contextIndependence', 'Standalone'],
  ['hookPotential', 'Hook'],
  ['retentionPotential', 'Retention'],
  ['sharePotential', 'Shareability'],
  ['novelty', 'Novelty'],
  ['editability', 'Editability'],
  ['confidence', 'Confidence'],
];
const friendly: Record<string, string> = {
  READY: 'Ready',
  UPLOADED: 'Queued',
  PROCESSING: 'Validating',
  ANALYZING: 'Analyzing',
  SUCCEEDED: 'Completed',
  FAILED: 'Failed',
  PENDING: 'Pending',
  RUNNING: 'Running',
  RETRYING: 'Retrying',
  EDIT_PLANNED: 'Edit planned',
  RENDERING: 'Rendering',
  QC: 'Quality check',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};
function Badge({ state }: { state: string }) {
  return (
    <StatusBadge variant="outline" data-status={state.toLowerCase()}>
      <span className="status-dot" aria-hidden="true" />
      {friendly[state] ?? state}
    </StatusBadge>
  );
}
function ErrorBox({ message }: { message: string }) {
  return message ? (
    <Alert variant="destructive" className="error-message">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  ) : null;
}
function useData<T>(path: string) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      setData(await api<T>(path));
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }, [path]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await api<T>(path);
        if (active) {
          setData(result);
          setError('');
        }
      } catch (e) {
        if (active) setError(errorText(e));
      }
    };
    void load();
    const timer = setInterval(() => {
      void load();
    }, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [path]);
  return { data, error, refresh };
}
function PageTitle({
  eyebrow: _eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children}
    </header>
  );
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <EmptyState className="recordings-empty">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Film />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{text}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline">
          <Link to="/uploads">
            <Plus data-icon="inline-start" />
            Upload gameplay
          </Link>
        </Button>
      </EmptyContent>
    </EmptyState>
  );
}
function SourceRows({ sources }: { sources: SourceView[] }) {
  return (
    <div className="source-list">
      {sources.map((source) => (
        <Link to={`/library/${source.id}`} className="source-row" key={source.id}>
          <div className="file-icon">
            <Film size={22} />
          </div>
          <div className="source-name">
            <strong>{source.filename}</strong>
            <small>
              {source.width ? `${source.width} × ${source.height}` : 'Metadata pending'}{' '}
              <span>·</span> {bytes(source.bytes)} <span>·</span> {duration(source.duration)}
            </small>
          </div>
          <Badge state={source.status} />
          <ChevronRight size={18} />
        </Link>
      ))}
    </div>
  );
}
function Dashboard() {
  const { data, error } = useData<{
    total: number;
    ready: number;
    failed: number;
    processing: number;
    bytes: string;
    duration: number;
    recent: SourceView[];
    aiUsage: AiUsageView;
  }>('/dashboard');
  return (
    <>
      <PageTitle
        eyebrow="YOUR CREATOR WORKSPACE"
        title="Your studio, at a glance."
        description="A little less admin. A lot more gameplay."
      >
        <Link className="button secondary" to="/queue">
          <Clock3 size={17} />
          View job queue
        </Link>
      </PageTitle>
      <ErrorBox message={error} />
      <DashboardHero />
      <div className="stats">
        {[
          ['Source recordings', data?.total, FolderOpen],
          ['Analysis ready', data?.ready, ShieldCheck],
          ['In progress', data?.processing, Clock3],
          ['Needs attention', data?.failed, Activity],
        ].map(([label, value, Icon]) => {
          const MetricIcon = Icon as typeof Film;
          return (
            <section className="stat" key={String(label)}>
              <div>
                <span>{String(label)}</span>
                <MetricIcon size={18} />
              </div>
              <strong>
                {value === undefined ? <Skeleton className="h-9 w-12" /> : String(value)}
              </strong>
              <small>
                {label === 'Analysis ready'
                  ? 'Analyzed and ready to review'
                  : label === 'Needs attention'
                    ? 'Failed processing jobs'
                    : label === 'In progress'
                      ? 'Queued, validating, or analyzing'
                      : data
                        ? `${bytes(data.bytes)} of original footage`
                        : 'Loading your library'}
              </small>
            </section>
          );
        })}
      </div>
      {data && (
        <section className="ai-usage-strip" aria-label="AI ranking usage">
          <Sparkles size={17} aria-hidden="true" />
          <div>
            <strong>
              {data.aiUsage.mode === 'openai' ? 'OpenAI ranking' : 'Development mock ranking'}
            </strong>
            <span>
              {data.aiUsage.calls} cached analysis {data.aiUsage.calls === 1 ? 'result' : 'results'}{' '}
              · {data.aiUsage.inputTokens + data.aiUsage.outputTokens} tokens · estimated $
              {Number(data.aiUsage.estimatedCostUsd).toFixed(4)}
            </span>
          </div>
        </section>
      )}
      <div className="dashboard-grid">
        <section className="panel">
          <div className="panel-heading">
            <h2>Recent recordings</h2>
            <Link to="/library">
              View library <ArrowRight size={15} />
            </Link>
          </div>
          {data?.recent.length ? (
            <SourceRows sources={data.recent} />
          ) : data ? (
            <Empty
              title="A fresh start for your footage"
              text="Your uploaded recordings will appear here."
            />
          ) : (
            <div className="loading-rows" role="status" aria-label="Loading recordings">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          )}
        </section>
        <section className="panel workflow">
          <div className="panel-heading">
            <h2>A good place to start</h2>
            <CircleHelp size={18} aria-hidden="true" />
          </div>
          {[
            ['01', 'Upload your gameplay', 'MP4, MOV, or WebM. Resume interrupted uploads.'],
            ['02', 'Validate the recording', 'Check format, resolution, audio and file integrity.'],
            ['03', 'Find candidate moments', 'Measure scene, motion, and audio activity.'],
          ].map(([n, t, d]) => (
            <div className="step" key={n}>
              <span>{n}</span>
              <div>
                <h3>{t}</h3>
                <p>{d}</p>
              </div>
            </div>
          ))}
          <Link className="workflow-link" to="/uploads">
            Bring in your first session
            <ArrowRight size={16} />
          </Link>
        </section>
      </div>
      <FuturePreview />
    </>
  );
}
function Uploads() {
  const { data: config } = useData<{ maxUploadBytes: number }>('/config');
  const { data, error: listError, refresh } = useData<{ uploads: UploadView[] }>('/uploads');
  const [file, setFile] = useState<File | null>(null),
    [rights, setRights] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [stage, setStage] = useState(''),
    [resumeId, setResumeId] = useState<string | null>(null),
    [sourceId, setSourceId] = useState('');
  async function send() {
    if (!file || !rights) return;
    setBusy(true);
    setError('');
    setSourceId('');
    try {
      const ext = file.name.split('.').pop()?.toLowerCase();
      const mimeType =
        ext === 'mov' ? 'video/quicktime' : ext === 'webm' ? 'video/webm' : 'video/mp4';
      const upload = resumeId
        ? await api<UploadView>(`/uploads/${resumeId}`)
        : await post<UploadView>('/uploads', {
            filename: file.name,
            bytes: file.size,
            mimeType,
            rightsAcknowledged: true,
          });
      setResumeId(upload.id);
      if (upload.sourceId) {
        setSourceId(upload.sourceId);
        setStage('Upload already completed.');
        setResumeId(null);
        setFile(null);
        setRights(false);
        await refresh();
        return;
      }
      if (upload.filename !== file.name || Number(upload.bytes) !== file.size)
        throw new Error('To resume, select the same original file with the same name and size.');
      const count = Math.ceil(file.size / upload.chunkBytes);
      for (let i = 0; i < count; i++) {
        setStage(`Uploading part ${i + 1} of ${count}`);
        const chunk = file.slice(
          i * upload.chunkBytes,
          Math.min(file.size, (i + 1) * upload.chunkBytes),
        );
        const hash = Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', await chunk.arrayBuffer())),
        )
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        const storedHash = upload.partHashes?.[String(i)];
        if (storedHash && storedHash !== hash)
          throw new Error(
            'This file differs from the original upload. Select the original file or cancel and start again.',
          );
        if (!storedHash)
          await api(`/uploads/${upload.id}/parts/${i}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: chunk,
          });
        setProgress(Math.round(((i + 1) / count) * 100));
      }
      setStage('Finalizing upload…');
      const source = await post<SourceView>(`/uploads/${upload.id}/complete`);
      setSourceId(source.id);
      setStage('Upload complete. Processing is queued.');
      setResumeId(null);
      setFile(null);
      setRights(false);
      await refresh();
    } catch (e) {
      setError(errorText(e));
      setStage('Upload paused. Select the same file to resume.');
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function cancel(id: string) {
    try {
      await api(`/uploads/${id}`, { method: 'DELETE' });
      if (id === resumeId) setResumeId(null);
      await refresh();
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="SOURCE FOOTAGE"
        title="Upload gameplay"
        description="Your originals, safely stored and ready for what comes next."
      />
      <ErrorBox message={error || listError} />
      <div className="upload-layout">
        <section className="panel upload-panel">
          <label
            className={`drop-zone ${busy ? 'busy' : ''}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (!busy) {
                setFile(e.dataTransfer.files[0] ?? null);
                setProgress(0);
              }
            }}
          >
            <UploadCloud size={38} />
            <h2>{file ? file.name : 'Drop your recording here'}</h2>
            <p>
              or <span>browse files</span> to get started
            </p>
            <small>
              MP4, MOV, WebM · Up to{' '}
              {config ? bytes(config.maxUploadBytes) : 'your configured limit'}
            </small>
            <input
              aria-label="Choose gameplay video"
              type="file"
              accept=".mp4,.mov,.webm"
              disabled={busy}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setProgress(0);
              }}
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={rights}
              disabled={busy}
              onChange={(e) => setRights(e.target.checked)}
            />
            <span>I own this footage or have the necessary permission to publish it.</span>
          </label>
          {resumeId && (
            <p className="resume-note">
              Resuming upload <code>{resumeId.slice(0, 8)}</code>. Select its original recording.
            </p>
          )}
          <button
            className="button primary full"
            disabled={!file || !rights || busy}
            onClick={() => {
              void send();
            }}
          >
            <UploadCloud size={18} />
            {busy ? stage : resumeId ? 'Resume upload' : 'Upload recording'}
          </button>
          {(busy || stage) && (
            <div className="upload-progress" aria-live="polite">
              <progress max={100} value={progress} />
              <p>
                {stage} {busy ? `${progress}% transferred` : ''}
              </p>
            </div>
          )}
          {sourceId && (
            <Link className="success-link" to={`/library/${sourceId}`}>
              <Check size={18} /> Open your recording <ArrowRight size={16} />
            </Link>
          )}
        </section>
        <aside className="panel upload-help">
          <ShieldCheck size={27} />
          <h2>Made for long sessions.</h2>
          <p>
            Uploads are saved in parts. If your connection drops, choose the same file and pick up
            where you left off.
          </p>
          <Separator />
          <h3>What happens next?</h3>
          <p>
            A background worker checks the actual format, reads its metadata, and decodes the
            recording to check for corruption.
          </p>
          <p>
            Your original file stays intact. Ingestion does not create highlights or publish
            content.
          </p>
        </aside>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>Unfinished uploads</h2>
          <span className="muted">Saved for 24 hours by default</span>
        </div>
        {data?.uploads.length ? (
          data.uploads.map((u) => (
            <div className="source-row" key={u.id}>
              <Film size={24} />
              <div className="source-name">
                <strong>{u.filename}</strong>
                <small>
                  {u.receivedParts.length} of {Math.ceil(Number(u.bytes) / u.chunkBytes)} parts
                  received · {bytes(u.bytes)}
                </small>
              </div>
              <button
                disabled={busy}
                className="button secondary"
                onClick={() => {
                  setResumeId(u.id);
                  setFile(null);
                  setStage('Select the original recording above.');
                }}
              >
                Resume
              </button>
              <button
                disabled={busy}
                aria-label={`Cancel upload ${u.filename}`}
                className="icon-button"
                onClick={() => {
                  void cancel(u.id);
                }}
              >
                <X size={18} />
              </button>
            </div>
          ))
        ) : (
          <p className="muted pad">No unfinished uploads.</p>
        )}
      </section>
    </>
  );
}
function Library() {
  const [search, setSearch] = useState(''),
    [status, setStatus] = useState(''),
    [page, setPage] = useState(1);
  const { data, error } = useData<{ sources: SourceView[]; total: number }>(
    `/sources?page=${page}&search=${encodeURIComponent(search)}${status ? `&status=${status}` : ''}`,
  );
  return (
    <>
      <PageTitle
        eyebrow="YOUR ORIGINALS"
        title="Source library"
        description="Every recording, with its metadata and ingestion history."
      >
        <Link className="button primary" to="/uploads">
          <Plus size={17} /> Upload gameplay
        </Link>
      </PageTitle>
      <ErrorBox message={error} />
      <div className="filters">
        <input
          aria-label="Search recordings"
          placeholder="Search recordings…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <select
          aria-label="Filter status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {['UPLOADED', 'PROCESSING', 'ANALYZING', 'READY', 'FAILED'].map((s) => (
            <option key={s} value={s}>
              {friendly[s]}
            </option>
          ))}
        </select>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>Recordings</h2>
          <span className="muted">{data?.total ?? '—'} total</span>
        </div>
        {data?.sources.length ? (
          <SourceRows sources={data.sources} />
        ) : data ? (
          <Empty
            title={search || status ? 'No matching recordings' : 'Your library is ready'}
            text={
              search || status
                ? 'Try a different search or filter.'
                : 'Start by uploading your first gameplay session.'
            }
          />
        ) : (
          <p className="pad">Loading…</p>
        )}
      </section>
      <div className="pagination">
        <button
          className="button secondary"
          disabled={page === 1}
          onClick={() => setPage(page - 1)}
        >
          Previous
        </button>
        <span>Page {page}</span>
        <button
          className="button secondary"
          disabled={!data || page * 25 >= data.total}
          onClick={() => setPage(page + 1)}
        >
          Next
        </button>
      </div>
    </>
  );
}
function SourceDetail() {
  const { id } = useParams();
  const { data, error, refresh } = useData<SourceView>(`/sources/${id}`);
  const [actionError, setActionError] = useState(''),
    [busy, setBusy] = useState(false);
  const [game, setGame] = useState('');
  async function retry() {
    setBusy(true);
    try {
      await post(`/sources/${id}/retry`);
      await refresh();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function analyzeAgain() {
    setBusy(true);
    setActionError('');
    try {
      await post(`/sources/${id}/analyze`);
      await refresh();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function saveGame() {
    if (!game) return;
    setBusy(true);
    setActionError('');
    try {
      await api(`/sources/${id}/game`, { method: 'PUT', body: JSON.stringify({ game }) });
      setGame('');
      await refresh();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function createShorts() {
    setBusy(true);
    setActionError('');
    try {
      await post(`/sources/${id}/shorts`);
      await refresh();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Link className="back-link" to="/library">
        <ArrowLeft size={16} /> Source library
      </Link>
      <PageTitle
        eyebrow="RECORDING DETAILS"
        title={data?.filename ?? 'Recording'}
        description="Original media, analysis signals, and candidate moments."
      />
      <ErrorBox message={error || actionError} />
      {data && (
        <>
          <div className="detail-actions">
            <Badge state={data.status} />
            <a className="button secondary" href={`/api/sources/${data.id}/download`}>
              <ArrowDownToLine size={16} /> Download original
            </a>
            {data.status === 'FAILED' && (
              <button
                disabled={busy}
                className="button primary"
                onClick={() => {
                  void retry();
                }}
              >
                <RefreshCw size={16} /> Retry processing
              </button>
            )}
            {data.duration &&
              !data.shorts?.length &&
              !['PROCESSING', 'ANALYZING'].includes(data.status) && (
                <button
                  disabled={busy}
                  className="button secondary"
                  onClick={() => void analyzeAgain()}
                >
                  <ScanSearch size={16} /> Analyze again
                </button>
              )}
            {data.candidates?.some((candidate) => candidate.score) && !data.shorts?.length && (
              <button
                disabled={busy}
                className="button primary"
                onClick={() => void createShorts()}
              >
                <WandSparkles size={16} /> Create Shorts
              </button>
            )}
          </div>
          <section className="panel metadata">
            {[
              ['Duration', duration(data.duration)],
              ['Resolution', data.width ? `${data.width} × ${data.height}` : 'Pending'],
              ['Video codec', data.videoCodec ?? 'Pending'],
              [
                'Audio',
                data.hasAudio === null
                  ? 'Pending'
                  : data.hasAudio
                    ? (data.audioCodec ?? 'Present')
                    : 'No audio track',
              ],
              ['File size', bytes(data.bytes)],
              ['Frame rate', data.frameRate ? `${data.frameRate.toFixed(2)} fps` : 'Pending'],
              ['Uploaded', new Date(data.createdAt).toLocaleString()],
              [
                'Publishing rights',
                `Acknowledged ${new Date(data.rightsAcknowledgedAt).toLocaleDateString()}`,
              ],
            ].map(([k, v]) => (
              <div key={k}>
                <small>{k}</small>
                <strong>{v}</strong>
              </div>
            ))}
          </section>
          {data.analysis?.status === 'SUCCEEDED' && (
            <section className="analysis-layout">
              <div className="panel analysis-preview">
                <div className="panel-heading">
                  <h2>Analysis proxy</h2>
                  <span className="muted">Optimized review copy</span>
                </div>
                <video
                  controls
                  preload="metadata"
                  poster={`/api/sources/${data.id}/assets/thumbnail`}
                  src={`/api/sources/${data.id}/assets/proxy`}
                />
              </div>
              <div className="panel analysis-summary">
                <div className="panel-heading">
                  <h2>Signal summary</h2>
                </div>
                <div className="signal-grid">
                  <span>
                    <strong>{data.analysis.sceneCount}</strong> scene changes
                  </span>
                  <span>
                    <strong>{data.analysis.motionPeakCount}</strong> motion peaks
                  </span>
                  <span>
                    <strong>{data.analysis.audioPeakCount}</strong> audio peaks
                  </span>
                  <span>
                    <strong>{data.analysis.silenceSegmentCount}</strong> quiet spans
                  </span>
                </div>
                <div className="game-control">
                  <small>Detected game</small>
                  <strong>{data.gameDetection?.game ?? 'Pending'}</strong>
                  <span className="muted">
                    {data.gameDetection
                      ? `${Math.round(data.gameDetection.confidence * 100)}% confidence · ${data.gameDetection.method.toLowerCase().replace('_', ' ')}`
                      : 'No detection result yet'}
                  </span>
                  <div>
                    <select
                      aria-label="Correct detected game"
                      value={game}
                      disabled={Boolean(data.shorts?.length)}
                      onChange={(event) => setGame(event.target.value)}
                    >
                      <option value="">Correct game…</option>
                      {[
                        'Unknown gameplay',
                        'Grand Theft Auto V',
                        'Grand Theft Auto VI',
                        'EA Sports FC',
                        'FIFA',
                        'Call of Duty',
                        'Call of Duty: Warzone',
                        'Fortnite',
                        'Valorant',
                        'Apex Legends',
                        'Minecraft',
                        'Rocket League',
                        'NBA 2K',
                      ].map((name) => (
                        <option key={name}>{name}</option>
                      ))}
                    </select>
                    <button
                      className="button secondary"
                      disabled={!game || busy || Boolean(data.shorts?.length)}
                      onClick={() => void saveGame()}
                    >
                      Save
                    </button>
                  </div>
                  {Boolean(data.shorts?.length) && (
                    <small>
                      Locked after Short creation to preserve the approved source evidence.
                    </small>
                  )}
                </div>
              </div>
            </section>
          )}
          {data.analysis?.status === 'SUCCEEDED' && data.candidates && (
            <section className="panel">
              <div className="panel-heading">
                <h2>Candidate moments</h2>
                <span className="muted">Ranked finalists include 15 explainable dimensions</span>
              </div>
              {data.candidates.length ? (
                <div className="candidate-list">
                  {[...data.candidates]
                    .sort(
                      (a, b) =>
                        (b.score?.highlightScore ?? -1) - (a.score?.highlightScore ?? -1) ||
                        b.signalScore - a.signalScore,
                    )
                    .map((candidate) => (
                      <div className="candidate-row" key={candidate.id}>
                        <span className="candidate-play">
                          <Play size={16} />
                        </span>
                        <div>
                          <strong>{eventLabel(candidate.eventType)}</strong>
                          <small>
                            {duration(candidate.startTime)}–{duration(candidate.endTime)} · event at{' '}
                            {duration(candidate.eventTime)}
                          </small>
                          <p>{candidate.score?.reason ?? candidate.reason}</p>
                          {candidate.score && (
                            <details className="score-details">
                              <summary>
                                Score breakdown ·{' '}
                                {candidate.score.provider === 'openai'
                                  ? candidate.score.model
                                  : 'mock fixture'}
                                {candidate.score.cached ? ' · cached' : ''}
                              </summary>
                              <div className="score-grid">
                                {scoreDimensions.map(([key, label]) => (
                                  <span key={key}>
                                    <small>{label}</small>
                                    <strong>{candidate.score?.[key]}</strong>
                                  </span>
                                ))}
                              </div>
                            </details>
                          )}
                        </div>
                        <span
                          className={`signal-score ${candidate.score ? 'rank-score' : ''}`}
                          title={candidate.score ? 'AI highlight score' : 'Local signal score'}
                        >
                          {candidate.score?.highlightScore ?? candidate.signalScore}
                        </span>
                      </div>
                    ))}
                </div>
              ) : (
                <p className="muted pad">No distinct activity windows were found.</p>
              )}
            </section>
          )}
          <section className="panel">
            <div className="panel-heading">
              <h2>Generated Shorts</h2>
              <span className="muted">{data.shorts?.length ?? 0} planned from this source</span>
            </div>
            {data.shorts?.length ? (
              <div className="short-list compact">
                {data.shorts.map((short) => (
                  <Link to={`/shorts/${short.id}`} className="short-row" key={short.id}>
                    <div className="short-poster">
                      <Clapperboard size={22} />
                    </div>
                    <div>
                      <strong>{short.title}</strong>
                      <small>{short.selectedConcept?.hook ?? 'Edit plan ready'}</small>
                    </div>
                    <Badge state={short.state} />
                    <ChevronRight size={18} />
                  </Link>
                ))}
              </div>
            ) : (
              <p className="muted pad">
                Ranked moments become structured edits here automatically.
              </p>
            )}
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h2>Processing jobs</h2>
            </div>
            <JobRows jobs={data.jobs} />
          </section>
          <p className="phase-note">
            Phase 4 preserves the measured ranking pipeline, then turns finalists into versioned,
            validated edit plans. Mock mode remains explicitly labeled and makes no visual claims.
          </p>
        </>
      )}
    </>
  );
}

type ShortDetailView = Omit<ShortSummaryView, 'source' | 'renders'> & {
  sourceId: string;
  description: string;
  hashtags: string[];
  editorialRole: string | null;
  reuseKind: string | null;
  reuseOfId: string | null;
  reuseReason: string | null;
  confidence: number;
  source: {
    id: string;
    filename: string;
    width: number;
    height: number;
    hasAudio: boolean;
    rightsAcknowledgedAt: string;
  };
  candidate: {
    startTime: number;
    eventTime: number;
    endTime: number;
    reason: string;
    score: HighlightScoreView;
    detectedEvent?: { eventType: string; confidence: number };
    concepts: Array<{
      id: string;
      key: string;
      concept: string;
      hook: string;
      rationale: string;
      selected: boolean;
    }>;
  };
  editPlans: Array<{
    id: string;
    version: number;
    document: EditDecisionList;
    validatedAt: string;
  }>;
  renders: Array<{
    id: string;
    state: string;
    qc: Record<string, unknown> | null;
    errorMessage: string | null;
    job: JobView;
  }>;
};

function ShortsPage() {
  const { data, error } = useData<{ shorts: ShortSummaryView[] }>('/shorts');
  return (
    <>
      <PageTitle
        eyebrow="AI EDITOR"
        title="Shorts"
        description="Review planned vertical edits, render progress, and QC-approved videos."
      />
      <ErrorBox message={error} />
      <section className="panel">
        <div className="panel-heading">
          <h2>Created Shorts</h2>
          <span className="muted">Latest 100</span>
        </div>
        {data?.shorts.length ? (
          <div className="short-list">
            {data.shorts.map((short) => (
              <Link to={`/shorts/${short.id}`} className="short-row" key={short.id}>
                <div className="short-poster">
                  <Play size={20} />
                </div>
                <div className="short-copy">
                  <strong>{short.title}</strong>
                  <small>
                    {short.game} · {eventLabel(short.eventType ?? '')} ·{' '}
                    {duration(short.duration ?? null)}
                  </small>
                  <p>{short.selectedConcept?.concept}</p>
                </div>
                <span className="quality-score">
                  {short.qualityScore ?? '—'}
                  <small>quality</small>
                </span>
                <div className="short-states">
                  <Badge state={short.state} />
                  <Badge state={short.reviewState} />
                </div>
                <ChevronRight size={18} />
              </Link>
            ))}
          </div>
        ) : data ? (
          <Empty
            title="No Shorts yet"
            text="Ranked highlights are converted into editable vertical concepts automatically."
          />
        ) : (
          <p className="pad">Loading…</p>
        )}
      </section>
      <p className="phase-note">
        Every video remains in manual review by default. Publishing and daily slate assignment begin
        in later phases.
      </p>
    </>
  );
}

function ShortDetail() {
  const { id } = useParams(),
    { data, error, refresh } = useData<ShortDetailView>(`/shorts/${id}`);
  const [actionError, setActionError] = useState(''),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(''),
    [description, setDescription] = useState(''),
    [hashtags, setHashtags] = useState('');
  useEffect(() => {
    if (data) {
      setTitle(data.title);
      setDescription(data.description);
      setHashtags(data.hashtags.join(' '));
    }
  }, [data?.id, data?.title, data?.description, data?.hashtags.join(' ')]);
  async function action(path: string, body?: unknown) {
    setBusy(true);
    setActionError('');
    try {
      await post(path, body);
      await refresh();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function saveMetadata(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setActionError('');
    try {
      await api(`/shorts/${id}/metadata`, {
        method: 'PATCH',
        body: JSON.stringify({
          title,
          description,
          hashtags: hashtags.split(/\s+/).filter(Boolean),
        }),
      });
      setEditing(false);
      await refresh();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const plan = data?.editPlans[0],
    edl = plan?.document,
    latestRender = data?.renders[0];
  return (
    <>
      <Link className="back-link" to="/shorts">
        <ArrowLeft size={16} /> Shorts
      </Link>
      <PageTitle
        eyebrow="SHORT DETAIL"
        title={data?.title ?? 'Short'}
        description="The selected concept, structured edit plan, render, and review decision."
      />
      <ErrorBox message={error || actionError} />
      {data && edl && (
        <>
          <div className="detail-actions">
            <Badge state={data.state} />
            <Badge state={data.reviewState} />
            <button
              className="button secondary"
              disabled={busy || ['RENDERING', 'QC'].includes(data.state)}
              onClick={() => void action(`/shorts/${id}/render`)}
            >
              <RefreshCw size={16} /> Re-render
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setEditing(!editing)}
            >
              <Settings size={16} /> Edit metadata
            </button>
            <button
              className="button primary"
              disabled={busy || data.state !== 'READY'}
              onClick={() => void action(`/shorts/${id}/review`, { decision: 'APPROVED' })}
            >
              <CheckCircle2 size={16} /> Approve
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void action(`/shorts/${id}/review`, { decision: 'REJECTED' })}
            >
              <X size={16} /> Reject
            </button>
          </div>
          {editing && <ReuseDeclaration id={data.id} initial={data} />}
          <p>
            Editorial role: {data.editorialRole ?? 'Unassigned'} ·{' '}
            <Link to="/calendar">Open editorial calendar</Link>
          </p>
          {editing && (
            <form className="panel metadata-form" onSubmit={(event) => void saveMetadata(event)}>
              <label>
                Title
                <input
                  value={title}
                  maxLength={100}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label>
                Description
                <textarea
                  value={description}
                  maxLength={500}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <label>
                Hashtags
                <input value={hashtags} onChange={(event) => setHashtags(event.target.value)} />
              </label>
              <div>
                <button className="button primary" disabled={busy}>
                  Save metadata
                </button>
              </div>
            </form>
          )}
          <div className="short-detail-grid">
            <section className="panel player-panel">
              <div className="panel-heading">
                <h2>Composition preview</h2>
                <span className="muted">Shared Remotion timeline · v{plan.version}</span>
              </div>
              <div className="vertical-player">
                <React.Suspense fallback={<div className="player-loading">Preparing preview…</div>}>
                  <RemotionPreview
                    videoSrc={`/api/sources/${data.source.id}/assets/proxy`}
                    sourceWidth={data.source.width}
                    sourceHeight={data.source.height}
                    hasAudio={data.source.hasAudio}
                    edl={edl}
                  />
                </React.Suspense>
              </div>
              {latestRender?.state === 'READY' && (
                <a className="button secondary full" href={`/api/shorts/${data.id}/media`}>
                  <ArrowDownToLine size={16} /> Open QC-approved MP4
                </a>
              )}
            </section>
            <section className="panel short-inspector">
              <div className="panel-heading">
                <h2>Editorial brief</h2>
              </div>
              <dl>
                <dt>Source</dt>
                <dd>
                  <Link to={`/library/${data.source.id}`}>{data.source.filename}</Link>
                </dd>
                <dt>Moment</dt>
                <dd>
                  {duration(data.candidate.startTime)}–{duration(data.candidate.endTime)} · payoff{' '}
                  {duration(data.sourceTimestamp ?? 0)}
                </dd>
                <dt>Game / event</dt>
                <dd>
                  {data.game} · {eventLabel(data.eventType ?? '')}
                </dd>
                <dt>Highlight / quality</dt>
                <dd>
                  {data.candidate.score.highlightScore} / {data.qualityScore}
                </dd>
                <dt>AI evidence</dt>
                <dd>{data.candidate.score.reason}</dd>
                <dt>Concept</dt>
                <dd>{data.selectedConcept?.concept}</dd>
                <dt>Hook</dt>
                <dd>{data.selectedConcept?.hook}</dd>
                <dt>Duration</dt>
                <dd>{edl.outputDuration.toFixed(1)} seconds</dd>
                <dt>Crop</dt>
                <dd>{eventLabel(edl.cropStrategy)}</dd>
                <dt>Editorial role</dt>
                <dd>{data.editorialRole ?? 'Unassigned'}</dd>
                <dt>Metadata</dt>
                <dd>
                  {data.description}
                  <br />
                  {data.hashtags.join(' ')}
                </dd>
              </dl>
            </section>
          </div>
          <section className="panel">
            <div className="panel-heading">
              <h2>Concept alternatives</h2>
              <span className="muted">One highlight, three editorial approaches</span>
            </div>
            <div className="concept-grid">
              {data.candidate.concepts.map((concept) => (
                <article className={concept.selected ? 'selected' : ''} key={concept.id}>
                  <small>{eventLabel(concept.key)}</small>
                  <strong>{concept.hook}</strong>
                  <p>{concept.concept}</p>
                  <span>{concept.rationale}</span>
                </article>
              ))}
            </div>
          </section>
          <section className="panel edl-panel">
            <div className="panel-heading">
              <h2>Validated edit decision list</h2>
              <span className="muted">
                Schema v{plan.version} · {edl.cuts.length} cut{edl.cuts.length === 1 ? '' : 's'}
              </span>
            </div>
            <pre>{JSON.stringify(edl, null, 2)}</pre>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h2>Render & QC history</h2>
            </div>
            {data.renders.length ? (
              <div className="render-history">
                {data.renders.map((render) => (
                  <div key={render.id}>
                    <Badge state={render.state} />
                    <span>
                      Attempt {render.job.attempt} · {render.job.progress}%
                    </span>
                    <small>
                      {render.errorMessage ??
                        (render.qc
                          ? 'Playable, 1080×1920, duration, audio, boundaries, safe text, rights, and metadata passed.'
                          : 'Waiting for renderer')}
                    </small>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted pad">No render attempts yet.</p>
            )}
          </section>
        </>
      )}
    </>
  );
}
function JobRows({ jobs }: { jobs: JobView[] }) {
  return (
    <div>
      {jobs.map((job) => (
        <div className="job-row" key={job.id}>
          <div className="job-header">
            <div>
              <strong>
                {job.source?.filename ??
                  (job.kind === 'ANALYZE'
                    ? 'Gameplay analysis'
                    : job.kind === 'RANK'
                      ? 'AI candidate ranking'
                      : job.kind === 'PLAN'
                        ? 'Short concept & edit plan'
                        : job.kind === 'RENDER'
                          ? 'Vertical render & QC'
                          : 'Media validation')}
              </strong>
              <small>
                Attempt {job.attempt} · {new Date(job.createdAt).toLocaleString()}
              </small>
            </div>
            <Badge state={job.state} />
          </div>
          <progress value={job.progress} max={100} />
          <small>
            {job.progress}% · {job.errorCode ?? job.kind}
          </small>
          {job.errorMessage && <p className="job-error">{job.errorMessage}</p>}
        </div>
      ))}
    </div>
  );
}
function QueuePage() {
  const { data, error } = useData<{ jobs: JobView[] }>('/jobs');
  return (
    <>
      <PageTitle
        eyebrow="BACKGROUND PROCESSING"
        title="Job queue"
        description="Follow ingestion, analysis, planning, rendering, QC, attempts, and failures."
      />
      <ErrorBox message={error} />
      <section className="panel">
        <div className="panel-heading">
          <h2>Recent processing jobs</h2>
          <span className="muted">Latest 100</span>
        </div>
        {data?.jobs.length ? (
          <JobRows jobs={data.jobs} />
        ) : (
          <p className="muted pad">
            {data ? 'No jobs yet. Upload a recording to begin.' : 'Loading jobs…'}
          </p>
        )}
      </section>
    </>
  );
}
function AnalysisPage() {
  const { data, error } = useData<{ sources: SourceView[]; aiUsage: AiUsageView }>('/analysis');
  return (
    <>
      <PageTitle
        eyebrow="MOMENT DISCOVERY"
        title="Gameplay analysis"
        description="Review game-aware events and explainable highlight rankings."
      />
      <ErrorBox message={error} />
      {data && (
        <section className="ai-usage-strip analysis-usage" aria-label="AI analysis usage">
          <Sparkles size={17} aria-hidden="true" />
          <div>
            <strong>
              {data.aiUsage.mode === 'openai'
                ? 'Live multimodal analysis'
                : 'Deterministic development mode'}
            </strong>
            <span>
              {data.aiUsage.calls} cached calls · {data.aiUsage.inputTokens} input /{' '}
              {data.aiUsage.outputTokens} output tokens · estimated $
              {Number(data.aiUsage.estimatedCostUsd).toFixed(4)}
            </span>
          </div>
        </section>
      )}
      <section className="panel">
        <div className="panel-heading">
          <h2>Analyzed recordings</h2>
          <span className="muted">Latest 100</span>
        </div>
        {data?.sources.length ? (
          <div className="analysis-list">
            {data.sources.map((source) => (
              <Link to={`/library/${source.id}`} className="analysis-row" key={source.id}>
                <img src={`/api/sources/${source.id}/assets/thumbnail`} alt="" />
                <div>
                  <strong>{source.filename}</strong>
                  <small>
                    <Gamepad2 size={14} /> {source.gameDetection?.game ?? 'Detection pending'}
                  </small>
                </div>
                <span>
                  {source.candidates?.filter((candidate) => candidate.score).length ?? 0} ranked
                  finalists
                </span>
                <Badge state={source.status} />
                <ChevronRight size={18} />
              </Link>
            ))}
          </div>
        ) : data ? (
          <Empty
            title="No analysis yet"
            text="Upload gameplay and the worker will analyze it automatically."
          />
        ) : (
          <p className="pad">Loading…</p>
        )}
      </section>
      <p className="phase-note">
        Rankings use bounded finalist sampling. Scores show editorial potential, not guaranteed
        performance; development mock results are labeled and remain non-semantic.
      </p>
    </>
  );
}
function HealthPage() {
  const [data, setData] = useState<{
      status: string;
      services: Record<string, string>;
      heartbeat: string | null;
      rendererHeartbeat: string | null;
    } | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch('/api/health', { signal: AbortSignal.timeout(10000) });
        const value = await response.json();
        if (!response.ok && response.status !== 503) throw new Error(value.message);
        if (active) {
          setData(value);
          setError('');
        }
      } catch (e) {
        if (active) setError(errorText(e));
      }
    };
    void load();
    const timer = setInterval(() => {
      void load();
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <>
      <PageTitle
        eyebrow="OPERATIONS"
        title="System health"
        description="Live readiness of the services behind your workspace."
      />
      <ErrorBox message={error} />
      <div className="health-grid">
        {Object.entries(data?.services ?? {}).map(([name, state]) => (
          <section className="panel health-card" key={name}>
            <Activity size={22} />
            <h2>{name}</h2>
            <Badge state={state} />
            <p>
              {name === 'worker'
                ? 'Validates media and recovers queued jobs.'
                : name === 'renderer'
                  ? 'Builds vertical compositions and enforces media QC.'
                  : name === 'database'
                    ? 'Source metadata, sessions, and durable job records.'
                    : name === 'redis'
                      ? 'Background job delivery and worker heartbeat.'
                      : 'Original recordings and upload parts.'}
            </p>
          </section>
        ))}
      </div>
      {data?.status === 'degraded' && (
        <div className="error">
          A service needs attention. Accepted uploads remain recorded in the database while the
          worker recovers.
        </div>
      )}
      <p className="muted">
        Last worker heartbeat:{' '}
        {data?.heartbeat ? new Date(data.heartbeat).toLocaleString() : 'Not available'}
      </p>
      <p className="muted">
        Last renderer heartbeat:{' '}
        {data?.rendererHeartbeat
          ? new Date(data.rendererHeartbeat).toLocaleString()
          : 'Not available'}
      </p>
      <p className="phase-note">
        Phase 4 separates media analysis from resource-intensive Remotion rendering. Publishing and
        scheduling remain unavailable until their implementation phases.
      </p>
    </>
  );
}
function SettingsPage({ user }: { user: User }) {
  const { data, error } = useData<{
    timezone: string;
    maxUploadBytes: number;
    chunkBytes: number;
    storage: string;
    aiMode: 'mock' | 'openai';
    aiModel: string;
    planningModel: string;
  }>('/config');
  return (
    <>
      <PageTitle
        eyebrow="WORKSPACE"
        title="Settings"
        description="Your account and current foundation configuration."
      />
      <ErrorBox message={error} />
      <section className="panel metadata">
        {[
          ['Account', user.email],
          ['Timezone', data?.timezone],
          ['Storage', data?.storage],
          ['Maximum recording size', data ? bytes(data.maxUploadBytes) : '…'],
          ['Upload chunk size', data ? bytes(data.chunkBytes) : '…'],
          ['AI ranking mode', data?.aiMode === 'openai' ? 'OpenAI multimodal' : 'Development mock'],
          ['AI ranking model', data?.aiModel],
          ['Short planning model', data?.planningModel],
        ].map(([k, v]) => (
          <div key={k}>
            <small>{k}</small>
            <strong>{v}</strong>
          </div>
        ))}
      </section>
      <ShortSettingsPanel />
      <p className="phase-note">
        Manual mode requires approval before editorial assignment. Autopilot permits assignment only
        when all configured thresholds pass. Review and explicitly schedule uploads in the editorial
        calendar.
      </p>
    </>
  );
}

type ShortSettings = {
  autopilotEnabled: boolean;
  minimumHighlightScore: number;
  minimumConfidence: number;
  minimumQualityScore: number;
  preferredHashtags: string[];
  bannedHashtags: string[];
};
function ShortSettingsPanel() {
  const { data, error, refresh } = useData<ShortSettings>('/settings/shorts');
  const [draft, setDraft] = useState<ShortSettings | null>(null),
    [message, setMessage] = useState('');
  useEffect(() => {
    if (data && !draft) setDraft(data);
  }, [data, draft]);
  if (!draft)
    return (
      <section className="panel pad">
        <ErrorBox message={error} />
        Loading short settings…
      </section>
    );
  const numberField = (
    key: 'minimumHighlightScore' | 'minimumConfidence' | 'minimumQualityScore',
    label: string,
  ) => (
    <label>
      {label}
      <input
        type="number"
        min={0}
        max={100}
        value={draft[key]}
        onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) })}
      />
    </label>
  );
  return (
    <section className="panel settings-editor">
      <div className="panel-heading">
        <h2>Short creation guardrails</h2>
        <span className="muted">Manual approval defaults</span>
      </div>
      <ErrorBox message={error || message} />
      <div className="settings-grid">
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={draft.autopilotEnabled}
            onChange={(event) => setDraft({ ...draft, autopilotEnabled: event.target.checked })}
          />
          <span>
            <strong>Autopilot preference</strong>
            <small>
              Allows threshold-qualified Shorts into editorial plans without manual approval.
              Uploads still require an explicit scheduling action in the calendar.
            </small>
          </span>
        </label>
        {numberField('minimumHighlightScore', 'Minimum highlight score')}
        {numberField('minimumConfidence', 'Minimum confidence')}
        {numberField('minimumQualityScore', 'Minimum render quality')}
        <label>
          Preferred hashtags
          <input
            value={draft.preferredHashtags.join(' ')}
            onChange={(event) =>
              setDraft({
                ...draft,
                preferredHashtags: event.target.value.split(/\s+/).filter(Boolean),
              })
            }
          />
        </label>
        <label>
          Banned hashtags
          <input
            value={draft.bannedHashtags.join(' ')}
            onChange={(event) =>
              setDraft({
                ...draft,
                bannedHashtags: event.target.value.split(/\s+/).filter(Boolean),
              })
            }
          />
        </label>
      </div>
      <div className="settings-actions">
        <button
          className="button primary"
          onClick={() => {
            setMessage('');
            void api('/settings/shorts', { method: 'PATCH', body: JSON.stringify(draft) })
              .then(() => refresh())
              .catch((e) => setMessage(errorText(e)));
          }}
        >
          Save guardrails
        </button>
      </div>
    </section>
  );
}
function Login({ onLogin }: { onLogin(user: User): void }) {
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onLogin((await post<{ user: User }>('/auth/login', { email, password })).user);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <div className="login-story">
        <div className="brand">
          <Clapperboard /> shorts<span>studio</span>
        </div>
        <div>
          <h1>
            Give your footage
            <br />a place to begin.
          </h1>
          <p>
            A creator workspace for the moments
            <br />
            worth keeping.
          </p>
        </div>
        <small>AI Gameplay Shorts Agent · Foundation</small>
      </div>
      <main className="login-main">
        <form
          className="login-form"
          onSubmit={(e) => {
            void submit(e);
          }}
        >
          <h1>Welcome back.</h1>
          <p>Sign in to manage your gameplay recordings.</p>
          <ErrorBox message={error} />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Button disabled={busy} type="submit" size="lg" className="w-full">
              {busy ? 'Signing in…' : 'Sign in'}
              <ArrowRight data-icon="inline-end" />
            </Button>
          </FieldGroup>
          <p className="login-note">Use the account provisioned by your workspace administrator.</p>
        </form>
      </main>
    </div>
  );
}
function App() {
  const location = useLocation();
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  useEffect(() => {
    const keyboard = () => {
      document.documentElement.dataset.input = 'keyboard';
    };
    const pointer = () => {
      document.documentElement.dataset.input = 'pointer';
    };
    window.addEventListener('keydown', keyboard);
    window.addEventListener('pointerdown', pointer);
    return () => {
      window.removeEventListener('keydown', keyboard);
      window.removeEventListener('pointerdown', pointer);
    };
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0);
    document.getElementById('main-content')?.focus({ preventScroll: true });
  }, [location.pathname]);
  useEffect(() => {
    void api<{ user: User }>('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => {})
      .finally(() => setLoading(false));
    const expired = () => setUser(null);
    window.addEventListener('session-expired', expired);
    return () => window.removeEventListener('session-expired', expired);
  }, []);
  if (loading) return <div className="loading">Opening your workspace…</div>;
  if (!user) return <Login onLogin={setUser} />;
  const nav = [
    ['/dashboard', 'Overview', LayoutDashboard],
    ['/uploads', 'Uploads', UploadCloud],
    ['/library', 'Source library', FolderOpen],
    ['/analysis', 'Analysis', ScanSearch],
    ['/shorts', 'Shorts', Clapperboard],
    ['/calendar', 'Editorial calendar', Clock3],
    ['/queue', 'Job queue', Clock3],
    ['/health', 'System health', Activity],
    ['/settings', 'Settings', Settings],
  ] as const;
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link to="/dashboard" className="brand">
          <span className="brand-mark">
            <Clapperboard size={22} />
          </span>{' '}
          shorts<span>studio</span>
        </Link>
        <div className="workspace-tag">
          <span /> Personal workspace
        </div>
        <nav aria-label="Main navigation">
          {nav.map(([to, text, Icon]) => (
            <NavLink key={to} to={to}>
              <Icon size={19} />
              {text}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="foundation">
            <Clapperboard size={22} aria-hidden="true" />
            <strong>More play. Less busywork.</strong>
            <p>Your footage is the starting point.</p>
            <Link to="/uploads">
              Add a recording
              <Plus size={14} />
            </Link>
          </div>
          <div className="account">
            <div className="avatar">{user.email[0]?.toUpperCase()}</div>
            <div>
              <strong>Creator account</strong>
              <small>{user.email}</small>
            </div>
            <button
              className="icon-button"
              aria-label="Sign out"
              onClick={() => {
                void post('/auth/logout')
                  .then(() => setUser(null))
                  .catch((e) => setError(errorText(e)));
              }}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <div className="topbar">
          <span>
            Personal workspace <ChevronRight size={14} />{' '}
            {nav.find(([path]) => location.pathname.startsWith(path))?.[1] ?? 'Overview'}
          </span>
          <span className="private-label">
            <ShieldCheck size={14} /> Private workspace
          </span>
        </div>
        <main className="content" id="main-content" tabIndex={-1}>
          <ErrorBox message={error} />
          <Routes>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/uploads" element={<Uploads />} />
            <Route path="/library" element={<Library />} />
            <Route path="/library/:id" element={<SourceDetail />} />
            <Route path="/analysis" element={<AnalysisPage />} />
            <Route path="/shorts" element={<ShortsPage />} />
            <Route path="/shorts/:id" element={<ShortDetail />} />
            <Route path="/calendar" element={<EditorialCalendar />} />
            <Route path="/queue" element={<QueuePage />} />
            <Route path="/health" element={<HealthPage />} />
            <Route path="/settings" element={<SettingsPage user={user} />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
          <footer>
            Your gameplay. Your originals.<span>Shorts Studio · Phase 6</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
