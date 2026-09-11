import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import {
  ArrowUpRight,
  Beaker,
  BrainCircuit,
  FlaskConical,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { api } from '../api.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

type Insight = {
  id: string;
  finding: string;
  confidence: string;
  sampleSize: number;
  dimension: string;
  segment: string;
  evidence: { liftPercent?: number };
};
type Strategy = { version: number; explorationRate: number; reason: string; createdAt: string };
type Learning = {
  window: string;
  lastRun: { state: string; finishedAt: string | null; errorMessage: string | null } | null;
  strategy: Strategy | null;
  insights: Insight[];
  evidence: {
    features: number;
    outcomes: Array<{ horizon: string; available: boolean; _count: number }>;
  };
  readiness: { ready: boolean; needed: number; message: string };
  caveat: string;
};
type Experiment = {
  id: string;
  name: string;
  hypothesis: string;
  dimension: string;
  controlValue: string;
  variantValue: string;
  status: string;
  allocationRate: number;
  confidence: string;
  results: {
    control?: { sample: number; score: number | null };
    variant?: { sample: number; score: number | null };
    liftPercent?: number | null;
  } | null;
  _count: { assignments: number };
};
const windows = ['7', '28', '90', 'lifetime'] as const;
const label = (value: string) =>
  value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replace(/^./, (c) => c.toUpperCase());

export function LearningWorkspace({
  mode = 'insights',
}: {
  mode?: 'overview' | 'insights' | 'experiments';
}) {
  const [window, setWindow] = useState<(typeof windows)[number]>('28');
  const [learning, setLearning] = useState<Learning | null>(null);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const [next, experimentData] = await Promise.all([
        api<Learning>(`/learning?window=${window}`),
        api<{ experiments: Experiment[] }>('/experiments'),
      ]);
      setLearning(next);
      setExperiments(experimentData.experiments);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load performance learning.');
    }
  }, [window]);
  useEffect(() => {
    void load();
  }, [load]);
  async function act(path: string, body?: unknown, method = 'POST') {
    setBusy(true);
    try {
      await api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The action could not be completed.');
    } finally {
      setBusy(false);
    }
  }
  if (mode === 'overview')
    return (
      <section className="learning-overview" aria-labelledby="learning-overview-title">
        <div className="learning-pulse" aria-hidden="true">
          <BrainCircuit size={24} />
        </div>
        <div>
          <span className="learning-kicker">PERFORMANCE LEARNING</span>
          <h2 id="learning-overview-title">The studio is building an evidence trail.</h2>
          <p>
            {learning?.readiness.message ?? 'Reading verified outcomes…'} Recommendations stay
            explainable and reversible.
          </p>
        </div>
        <div className="learning-overview-metrics">
          <span>
            <strong>{learning?.evidence.features ?? '—'}</strong> measured Shorts
          </span>
          <span>
            <strong>{learning?.insights.length ?? '—'}</strong> current insights
          </span>
          <span>
            <strong>
              {learning?.strategy
                ? `${Math.round(learning.strategy.explorationRate * 100)}%`
                : '25%'}
            </strong>{' '}
            exploration
          </span>
        </div>
        <Button asChild variant="outline">
          <a href="/ai-insights">
            Open AI insights <ArrowUpRight />
          </a>
        </Button>
      </section>
    );
  if (mode === 'experiments')
    return <Experiments experiments={experiments} busy={busy} error={error} act={act} />;
  const available = (horizon: string) =>
    learning?.evidence.outcomes.find((item) => item.horizon === horizon && item.available)
      ?._count ?? 0;
  return (
    <section className="learning-workspace">
      <div className="learning-toolbar">
        <Tabs value={window} onValueChange={(value) => setWindow(value as typeof window)}>
          <TabsList aria-label="Insight window">
            {windows.map((item) => (
              <TabsTrigger key={item} value={item}>
                {item === 'lifetime' ? 'Lifetime' : `${item} days`}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Button variant="outline" disabled={busy} onClick={() => void act('/learning/run')}>
          <RefreshCw className={busy ? 'spin' : ''} /> Refresh evidence
        </Button>
      </div>
      {error && (
        <p className="learning-error" role="alert">
          {error}
        </p>
      )}
      <div className="learning-ledger">
        <Card>
          <CardHeader>
            <CardTitle>Evidence readiness</CardTitle>
            <Badge variant="outline">{learning?.readiness.ready ? 'Ready' : 'Collecting'}</Badge>
          </CardHeader>
          <CardContent>
            <strong>{learning?.evidence.features ?? '—'}</strong>
            <p>measured published Shorts</p>
            <small>{learning?.readiness.message}</small>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Mature outcomes</CardTitle>
            <Badge variant="outline">Daily reports</Badge>
          </CardHeader>
          <CardContent>
            <strong>{available('7D')}</strong>
            <p>7-day outcomes</p>
            <small>
              {available('24H')} at 24h · {available('72H')} at 72h
            </small>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Active strategy</CardTitle>
            <Badge variant="outline">v{learning?.strategy?.version ?? 1}</Badge>
          </CardHeader>
          <CardContent>
            <strong>{Math.round((learning?.strategy?.explorationRate ?? 0.25) * 100)}%</strong>
            <p>reserved for exploration</p>
            <small>{learning?.strategy?.reason ?? 'Baseline strategy'}</small>
          </CardContent>
        </Card>
      </div>
      <div className="insight-heading">
        <div>
          <span className="learning-kicker">WHAT THE DATA SUGGESTS</span>
          <h2>Evidence before certainty.</h2>
        </div>
        <span>{learning?.insights.length ?? 0} findings</span>
      </div>
      <div className="insight-list">
        {learning?.insights.length ? (
          learning.insights.map((insight, index) => (
            <article
              className="insight-row"
              style={{ '--insight-index': index } as CSSProperties}
              key={insight.id}
            >
              <div className="insight-rank">{String(index + 1).padStart(2, '0')}</div>
              <div>
                <div className="insight-meta">
                  <Badge variant="outline">{insight.confidence} confidence</Badge>
                  <span>
                    {label(insight.dimension)} · {insight.sampleSize} Shorts
                  </span>
                </div>
                <h3>{insight.finding}</h3>
                <p>
                  Suggested weighting change for “{insight.segment}”. This affects ranking, never a
                  guaranteed prediction.
                </p>
              </div>
              <Button
                variant="outline"
                disabled={busy || insight.confidence === 'LOW'}
                onClick={() => void act(`/learning/insights/${insight.id}/apply`)}
              >
                <Sparkles /> Apply
              </Button>
            </article>
          ))
        ) : (
          <div className="learning-empty">
            <BrainCircuit />
            <h3>No defensible comparison yet</h3>
            <p>{learning?.readiness.message ?? 'Run learning after analytics synchronization.'}</p>
          </div>
        )}
      </div>
      <p className="learning-caveat">{learning?.caveat}</p>
    </section>
  );
}

function Experiments({
  experiments,
  busy,
  error,
  act,
}: {
  experiments: Experiment[];
  busy: boolean;
  error: string;
  act: (path: string, body?: unknown, method?: string) => Promise<void>;
}) {
  const [form, setForm] = useState({
    name: '',
    hypothesis: '',
    dimension: 'hookType',
    controlValue: 'DIRECT',
    variantValue: 'CURIOSITY',
  });
  return (
    <section className="learning-workspace experiments-workspace">
      {error && (
        <p className="learning-error" role="alert">
          {error}
        </p>
      )}
      <div className="experiment-grid">
        <Card className="experiment-builder">
          <CardHeader>
            <CardTitle>
              <FlaskConical /> Design a measured test
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p>
              Reserve a controlled share of future selections. One active test per dimension keeps
              attribution legible.
            </p>
            <label>
              Name
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Curiosity hook test"
              />
            </label>
            <label>
              Hypothesis
              <Input
                value={form.hypothesis}
                onChange={(e) => setForm({ ...form, hypothesis: e.target.value })}
                placeholder="Curiosity hooks improve retained attention."
              />
            </label>
            <label>
              Feature
              <select
                value={form.dimension}
                onChange={(e) => setForm({ ...form, dimension: e.target.value })}
              >
                <option value="hookType">Hook type</option>
                <option value="captionStyle">Caption style</option>
                <option value="durationBucket">Duration</option>
                <option value="editIntensity">Edit intensity</option>
                <option value="postingTime">Posting time</option>
                <option value="titleStyle">Title style</option>
              </select>
            </label>
            <div className="experiment-values">
              <label>
                Control
                <Input
                  value={form.controlValue}
                  onChange={(e) => setForm({ ...form, controlValue: e.target.value })}
                />
              </label>
              <label>
                Variant
                <Input
                  value={form.variantValue}
                  onChange={(e) => setForm({ ...form, variantValue: e.target.value })}
                />
              </label>
            </div>
            <Button
              disabled={busy || form.name.trim().length < 3 || form.hypothesis.trim().length < 10}
              onClick={() =>
                void act('/experiments', { ...form, allocationRate: 0.25, minimumSample: 8 })
              }
            >
              <Beaker /> Create draft
            </Button>
          </CardContent>
        </Card>
        <div className="experiment-list">
          {experiments.length ? (
            experiments.map((experiment) => (
              <article key={experiment.id} className="experiment-row">
                <div className="experiment-status">
                  <Badge variant="outline">{experiment.status}</Badge>
                  <span>{label(experiment.dimension)}</span>
                </div>
                <h3>{experiment.name}</h3>
                <p>{experiment.hypothesis}</p>
                <div className="experiment-arms">
                  <span>
                    Control <strong>{experiment.controlValue}</strong>
                  </span>
                  <span>
                    Variant <strong>{experiment.variantValue}</strong>
                  </span>
                </div>
                <small>
                  {experiment._count.assignments} assignments ·{' '}
                  {experiment.confidence.toLowerCase()} confidence
                </small>
                <div className="experiment-actions">
                  {experiment.status !== 'ACTIVE' &&
                    experiment.status !== 'COMPLETED' &&
                    experiment.status !== 'CANCELLED' && (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void act(`/experiments/${experiment.id}`, { action: 'ACTIVATE' }, 'PATCH')
                        }
                      >
                        Activate
                      </Button>
                    )}
                  {experiment.status === 'ACTIVE' && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void act(`/experiments/${experiment.id}`, { action: 'PAUSE' }, 'PATCH')
                        }
                      >
                        Pause
                      </Button>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void act(`/experiments/${experiment.id}`, { action: 'COMPLETE' }, 'PATCH')
                        }
                      >
                        Complete
                      </Button>
                    </>
                  )}
                </div>
              </article>
            ))
          ) : (
            <div className="learning-empty">
              <FlaskConical />
              <h3>No experiments yet</h3>
              <p>Create a draft when you have one variable and a falsifiable hypothesis.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
