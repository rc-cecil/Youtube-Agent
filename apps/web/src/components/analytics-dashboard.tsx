import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  ArrowRight,
  CalendarClock,
  ChartNoAxesCombined,
  Clock3,
  Eye,
  Play,
  RefreshCw,
  Sparkles,
  ThumbsUp,
  Users,
  WalletCards,
} from 'lucide-react';
import { api, post } from '../api.js';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type WindowKey = '7' | '28' | '90' | 'lifetime';
type Currency = 'USD' | 'GHS';
type Totals = {
  views: string | null;
  engagedViews: string | null;
  watchMinutes: number | null;
  averageViewDuration: number | null;
  averageViewPercentage: number | null;
  likes: string | null;
  comments: string | null;
  shares: string | null;
  subscribersGained: string | null;
  subscribersLost: string | null;
};
type AnalyticsResponse = {
  connected: boolean;
  window: WindowKey;
  timezone?: string;
  analyticsState: string;
  revenueState?: string;
  lastSyncedAt?: string | null;
  channel: { title: string; avatar: string | null; subscribers: string | null } | null;
  totals: Totals;
  estimatedRevenueUsd: number | null;
  series: Array<{
    date: string;
    views: string | null;
    engagedViews: string | null;
    watchMinutes: string | null;
  }>;
  topShorts: Array<
    {
      videoId: string;
      shortId: string | null;
      title: string;
      thumbnail: string;
      publishAt: string | null;
      estimatedRevenueUsd: number | null;
    } & Totals
  >;
  today: Array<{
    id: string;
    localTime: string;
    role: string;
    shortId: string | null;
    title: string | null;
    state: string;
  }>;
  published: number;
  scheduled: number;
  campaign: { startDate: string; endDate: string; verified: number; goal: number } | null;
  lastRun: {
    id: string;
    state: string;
    errorMessage: string | null;
    createdAt: string;
    finishedAt: string | null;
  } | null;
};
type RevenueTotal = {
  estimatedRevenue: number | null;
  estimatedAdRevenue: number | null;
  estimatedPremiumRevenue: number | null;
  monetizedPlaybacks: string | null;
  playbackBasedCpm: number | null;
  derivedRevenuePerThousandViews: number | null;
};
type RevenueShort = {
  videoId: string;
  shortId: string | null;
  title: string;
  publishAt: string | null;
  game: string;
  eventType: string;
  editorialRole: string;
  durationBucket: string;
  postingSlot: string;
  estimatedRevenue: number | null;
};
type AttributionRow = { label: string; estimatedRevenue: number; shorts: number };
type RevenueResponse = {
  connected: boolean;
  state: string;
  currency: Currency;
  lastSyncedAt?: string | null;
  source?: string;
  periods: null | {
    today: RevenueTotal;
    last7Days: RevenueTotal;
    last28Days: RevenueTotal;
    thisMonth: RevenueTotal;
    lifetimeCaptured: RevenueTotal;
  };
  topShorts: RevenueShort[];
  attribution?: Record<
    'byGame' | 'byEvent' | 'byEditorialRole' | 'byDuration' | 'byPostingSlot',
    AttributionRow[]
  >;
};

const chartConfig = {
  engagedViews: { label: 'Engaged views', color: 'var(--chart-1)' },
  views: { label: 'Views', color: 'var(--chart-2)' },
} satisfies ChartConfig;
const windows: Array<{ value: WindowKey; label: string }> = [
  { value: '7', label: '7 days' },
  { value: '28', label: '28 days' },
  { value: '90', label: '90 days' },
  { value: 'lifetime', label: 'Lifetime' },
];

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
function number(value: string | number | null | undefined, suffix = '') {
  if (value === null || value === undefined) return 'Unavailable';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${compact.format(parsed)}${suffix}` : 'Unavailable';
}
function money(value: number | null | undefined, currency: Currency) {
  if (value === null || value === undefined) return 'Unavailable';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}
function dateTime(value: string | null | undefined) {
  if (!value) return 'Not synced yet';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}
function stateLabel(value: string) {
  return value
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function useAnalytics(window: WindowKey) {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setData(await api<AnalyticsResponse>(`/analytics?window=${window}`));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Analytics could not be loaded.');
    }
  }, [window]);
  useEffect(() => {
    void load();
    const timer =
      window === 'lifetime' ? undefined : globalThis.setInterval(() => void load(), 30_000);
    return () => timer && globalThis.clearInterval(timer);
  }, [load, window]);
  return { data, error, load };
}

function Metric({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof Eye;
}) {
  return (
    <div className="analytics-metric">
      <span>
        <Icon size={16} aria-hidden="true" />
        {label}
      </span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function EmptyAnalytics({ connected }: { connected: boolean }) {
  return (
    <section className="analytics-empty" aria-labelledby="analytics-empty-title">
      <ChartNoAxesCombined aria-hidden="true" />
      <div>
        <h2 id="analytics-empty-title">
          {connected
            ? 'Your first verified snapshot is on its way'
            : 'Connect YouTube to see real performance'}
        </h2>
        <p>
          {connected
            ? 'Run a sync after a Short has published. YouTube can omit recent days until reporting is complete.'
            : 'Analytics stays unavailable until the channel connection authorizes YouTube Analytics access.'}
        </p>
      </div>
      <Button asChild variant="outline">
        <Link to="/settings">Open YouTube settings</Link>
      </Button>
    </section>
  );
}

function ChannelOverview({ data }: { data: AnalyticsResponse }) {
  const subscriberDelta =
    data.totals.subscribersGained === null || data.totals.subscribersLost === null
      ? null
      : BigInt(data.totals.subscribersGained) - BigInt(data.totals.subscribersLost);
  return (
    <>
      <div className="analytics-channel-line">
        <div className="analytics-channel">
          {data.channel?.avatar ? (
            <img src={data.channel.avatar} alt="" />
          ) : (
            <span aria-hidden="true">
              <Play size={16} />
            </span>
          )}
          <div>
            <strong>{data.channel?.title ?? 'YouTube channel'}</strong>
            <small>Reporting in {data.timezone ?? 'your configured timezone'}</small>
          </div>
        </div>
        <Badge variant="outline" data-status={data.analyticsState.toLowerCase()}>
          {stateLabel(data.analyticsState)}
        </Badge>
      </div>
      <div className="analytics-metrics" aria-label="Channel performance summary">
        <Metric
          label="Engaged views"
          value={number(data.totals.engagedViews)}
          detail={`${number(data.totals.views)} public views`}
          icon={Eye}
        />
        <Metric
          label="Watch time"
          value={number(data.totals.watchMinutes, ' min')}
          detail={`${number(data.totals.averageViewDuration, 's')} average view`}
          icon={Clock3}
        />
        <Metric
          label="Engagement"
          value={number(data.totals.likes)}
          detail={`${number(data.totals.comments)} comments · ${number(data.totals.shares)} shares`}
          icon={ThumbsUp}
        />
        <Metric
          label="Subscribers"
          value={number(data.channel?.subscribers)}
          detail={
            subscriberDelta === null
              ? 'Change unavailable'
              : `${subscriberDelta >= 0 ? '+' : ''}${subscriberDelta} in this window`
          }
          icon={Users}
        />
        <Metric
          label="Est. revenue"
          value={money(data.estimatedRevenueUsd, 'USD')}
          detail="YouTube estimate · USD"
          icon={WalletCards}
        />
        <Metric
          label="Published"
          value={number(data.published)}
          detail={`${number(data.scheduled)} scheduled`}
          icon={Play}
        />
        <Metric
          label="Campaign"
          value={data.campaign ? `${data.campaign.verified}/${data.campaign.goal}` : 'Not active'}
          detail="Verified or scheduled Shorts"
          icon={CalendarClock}
        />
      </div>
    </>
  );
}

function PerformanceChart({ data }: { data: AnalyticsResponse }) {
  const series = useMemo(
    () =>
      data.series.map((row) => ({
        ...row,
        views: row.views === null ? null : Number(row.views),
        engagedViews: row.engagedViews === null ? null : Number(row.engagedViews),
      })),
    [data.series],
  );
  if (!series.length) return <EmptyAnalytics connected={data.connected} />;
  return (
    <Card className="analytics-chart-panel">
      <CardHeader className="analytics-card-heading">
        <div>
          <CardTitle>Daily performance</CardTitle>
          <div className="analytics-chart-key" aria-label="Chart series">
            <span data-series="views">Public views</span>
            <span data-series="engaged">Engaged views</span>
          </div>
        </div>
        <span>Missing reporting days are left blank—not counted as zero.</span>
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={chartConfig}
          className="min-h-[280px] w-full aspect-auto"
          aria-label="Daily public and engaged views"
        >
          <AreaChart
            data={series}
            accessibilityLayer
            responsive
            style={{ width: '100%', height: '100%' }}
            margin={{ left: 2, right: 8, top: 12 }}
          >
            <defs>
              <linearGradient id="engaged-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-engagedViews)" stopOpacity={0.28} />
                <stop offset="95%" stopColor="var(--color-engagedViews)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              minTickGap={26}
              tickFormatter={(value: string) => value.slice(5)}
            />
            <YAxis
              width={44}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: number) => compact.format(value)}
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) => String(payload[0]?.payload.date ?? '')}
                />
              }
            />
            <Area
              dataKey="views"
              type="monotone"
              fill="transparent"
              stroke="var(--color-views)"
              strokeWidth={1.5}
              connectNulls={false}
              isAnimationActive={false}
            />
            <Area
              dataKey="engagedViews"
              type="monotone"
              fill="url(#engaged-fill)"
              stroke="var(--color-engagedViews)"
              strokeWidth={2}
              connectNulls={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ChartContainer>
        <details className="analytics-table-disclosure">
          <summary>View daily data table</summary>
          <div className="analytics-table-wrap">
            <table>
              <caption className="sr-only">Daily analytics data</caption>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Views</th>
                  <th>Engaged views</th>
                  <th>Watch minutes</th>
                </tr>
              </thead>
              <tbody>
                {data.series.map((row) => (
                  <tr key={row.date}>
                    <td>{row.date}</td>
                    <td>{number(row.views)}</td>
                    <td>{number(row.engagedViews)}</td>
                    <td>{number(row.watchMinutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

function TopShorts({ data, limit = 10 }: { data: AnalyticsResponse; limit?: number }) {
  return (
    <Card className="analytics-ranking">
      <CardHeader className="analytics-card-heading">
        <CardTitle>Top Shorts</CardTitle>
        <span>Ranked by engaged views in this window.</span>
      </CardHeader>
      <CardContent className="analytics-ranking-list">
        {data.topShorts.slice(0, limit).map((short, index) => (
          <div className="analytics-short-row" key={short.videoId}>
            <span className="analytics-rank">{String(index + 1).padStart(2, '0')}</span>
            <span className="analytics-thumbnail">
              <Play size={18} aria-hidden="true" />
              <img
                src={short.thumbnail}
                alt=""
                loading="lazy"
                onError={(event) => {
                  event.currentTarget.hidden = true;
                }}
              />
            </span>
            <div>
              <strong>{short.title}</strong>
              <small>
                {number(short.views)} views · {number(short.engagedViews)} engaged ·{' '}
                {number(short.averageViewDuration, 's')} average view
              </small>
              <small>
                {number(short.averageViewPercentage, '%')} viewed · {number(short.likes)} likes ·{' '}
                {number(short.shares)} shares · {number(short.subscribersGained)} subscribers ·{' '}
                {money(short.estimatedRevenueUsd, 'USD')} estimated
              </small>
            </div>
            {short.shortId ? (
              <Button asChild size="sm" variant="ghost">
                <Link to={`/shorts/${short.shortId}`} aria-label={`Open ${short.title}`}>
                  <ArrowRight />
                </Link>
              </Button>
            ) : null}
          </div>
        ))}
        {!data.topShorts.length ? (
          <p className="analytics-inline-empty">
            No per-Short observations are available for this window.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Today({ data }: { data: AnalyticsResponse }) {
  return (
    <Card className="analytics-today">
      <CardHeader className="analytics-card-heading">
        <CardTitle>Today’s publishing slate</CardTitle>
        <span>{data.timezone}</span>
      </CardHeader>
      <CardContent>
        {data.today.map((slot) => (
          <div className="analytics-slot" key={slot.id}>
            <time>{slot.localTime}</time>
            <div>
              <strong>{slot.title ?? stateLabel(slot.role)}</strong>
              <small>{stateLabel(slot.role)}</small>
            </div>
            <Badge variant="outline" data-status={slot.state.toLowerCase()}>
              {stateLabel(slot.state)}
            </Badge>
          </div>
        ))}
        {!data.today.length ? (
          <p className="analytics-inline-empty">No slate has been generated for today.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RevenueWorkspace({
  currency,
  onCurrency,
}: {
  currency: Currency;
  onCurrency: (value: Currency) => void;
}) {
  const [data, setData] = useState<RevenueResponse | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    api<RevenueResponse>(`/revenue?currency=${currency}`)
      .then((value) => current && setData(value))
      .catch(
        (reason) =>
          current &&
          setError(reason instanceof Error ? reason.message : 'Revenue could not be loaded.'),
      );
    return () => {
      current = false;
    };
  }, [currency]);
  const attributes = data?.attribution;
  return (
    <section className="analytics-workspace analytics-revenue" aria-label="Revenue analytics">
      <div className="analytics-toolbar">
        <div>
          <strong>Estimated revenue</strong>
          <span>Reported by YouTube · last synced {dateTime(data?.lastSyncedAt)}</span>
        </div>
        <Select value={currency} onValueChange={(value) => onCurrency(value as Currency)}>
          <SelectTrigger aria-label="Revenue currency">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="USD">USD</SelectItem>
            <SelectItem value="GHS">GHS</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {!data ? (
        <div className="analytics-loading">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      ) : !data.connected ? (
        <EmptyAnalytics connected={false} />
      ) : data.state === 'UNAVAILABLE' ? (
        <Alert>
          <WalletCards />
          <AlertDescription>
            Revenue data unavailable. The connected channel may not have access to monetary
            analytics or may not currently be monetized.
          </AlertDescription>
        </Alert>
      ) : !data.periods ? (
        <EmptyAnalytics connected />
      ) : (
        <>
          <div className="revenue-periods">
            {(
              [
                ['Today', data.periods.today],
                ['Last 7 days', data.periods.last7Days],
                ['Last 28 days', data.periods.last28Days],
                ['This month', data.periods.thisMonth],
                ['Lifetime captured', data.periods.lifetimeCaptured],
              ] as const
            ).map(([label, item]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{money(item.estimatedRevenue, currency)}</strong>
                <small>
                  {item.derivedRevenuePerThousandViews === null
                    ? 'Derived RPM unavailable'
                    : `${money(item.derivedRevenuePerThousandViews, currency)} derived per 1K views`}
                </small>
              </div>
            ))}
          </div>
          <Alert className="revenue-disclaimer">
            <Sparkles />
            <AlertDescription>
              Revenue is estimated and may change in YouTube’s final reporting. “Derived per 1K
              views” is calculated locally from captured views; it is not a provider-reported RPM.
            </AlertDescription>
          </Alert>
          <div className="analytics-two-column">
            <Card>
              <CardHeader className="analytics-card-heading">
                <CardTitle>Revenue by Short</CardTitle>
                <span>Lifetime captured observations</span>
              </CardHeader>
              <CardContent className="revenue-short-list">
                {data.topShorts.map((short) => (
                  <div key={short.videoId}>
                    <div>
                      <strong>{short.title}</strong>
                      <small>
                        {short.game} · {stateLabel(short.eventType)}
                      </small>
                    </div>
                    <span>{money(short.estimatedRevenue, currency)}</span>
                  </div>
                ))}
                {!data.topShorts.length ? (
                  <p className="analytics-inline-empty">No video-level revenue is available.</p>
                ) : null}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="analytics-card-heading">
                <CardTitle>Attribution</CardTitle>
                <span>Grouped from your published Shorts</span>
              </CardHeader>
              <CardContent>
                {attributes ? (
                  <Tabs defaultValue="byGame" className="attribution-tabs">
                    <TabsList variant="line" aria-label="Revenue attribution dimension">
                      <TabsTrigger value="byGame">Game</TabsTrigger>
                      <TabsTrigger value="byEvent">Event</TabsTrigger>
                      <TabsTrigger value="byDuration">Length</TabsTrigger>
                      <TabsTrigger value="byPostingSlot">Slot</TabsTrigger>
                      <TabsTrigger value="byEditorialRole">Role</TabsTrigger>
                    </TabsList>
                    {(
                      [
                        'byGame',
                        'byEvent',
                        'byDuration',
                        'byPostingSlot',
                        'byEditorialRole',
                      ] as const
                    ).map((key) => (
                      <TabsContent value={key} className="attribution-list" key={key}>
                        {attributes[key].slice(0, 6).map((row) => (
                          <div key={row.label}>
                            <span>
                              {stateLabel(row.label)}
                              <small>
                                {row.shorts} {row.shorts === 1 ? 'Short' : 'Shorts'}
                              </small>
                            </span>
                            <strong>{money(row.estimatedRevenue, currency)}</strong>
                          </div>
                        ))}
                      </TabsContent>
                    ))}
                  </Tabs>
                ) : (
                  <p className="analytics-inline-empty">
                    Attribution appears when video-level revenue is available.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </section>
  );
}

export function AnalyticsDashboard({
  mode = 'analytics',
}: {
  mode?: 'overview' | 'analytics' | 'revenue';
}) {
  const [window, setWindow] = useState<WindowKey>('28');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState('');
  const { data, error, load } = useAnalytics(window);
  async function sync() {
    setSyncing(true);
    setNotice('');
    try {
      const run = await post<{ id: string; state: string }>('/analytics/sync');
      setNotice(run.state === 'RUNNING' ? 'A sync is already running.' : 'Analytics sync queued.');
      await load();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'Analytics sync could not be queued.');
    } finally {
      setSyncing(false);
    }
  }
  if (mode === 'revenue') return <RevenueWorkspace currency={currency} onCurrency={setCurrency} />;
  return (
    <section
      className={`analytics-workspace analytics-${mode}`}
      aria-label={mode === 'overview' ? 'YouTube performance overview' : 'YouTube analytics'}
    >
      <div className="analytics-toolbar">
        <div>
          <strong>{mode === 'overview' ? 'Channel performance' : 'Verified performance'}</strong>
          <span>
            {data ? `Last synced ${dateTime(data.lastSyncedAt)}` : 'Loading YouTube Analytics'}
          </span>
        </div>
        <div className="analytics-controls">
          <Tabs value={window} onValueChange={(value) => setWindow(value as WindowKey)}>
            <TabsList aria-label="Analytics window">
              {windows.map((item) => (
                <TabsTrigger value={item.value} key={item.value}>
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Button variant="outline" size="sm" onClick={() => void sync()} disabled={syncing}>
            <RefreshCw data-icon="inline-start" className={syncing ? 'spin' : ''} />
            {syncing ? 'Queuing…' : 'Sync now'}
          </Button>
        </div>
      </div>
      {notice ? (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {!data ? (
        <div className="analytics-loading">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      ) : !data.connected || (!data.series.length && data.analyticsState !== 'SYNCED') ? (
        <EmptyAnalytics connected={data.connected} />
      ) : (
        <>
          <ChannelOverview data={data} />
          {mode === 'overview' ? (
            <div className="analytics-two-column">
              <TopShorts data={data} limit={3} />
              <Today data={data} />
            </div>
          ) : (
            <>
              <PerformanceChart data={data} />
              <div className="analytics-two-column">
                <TopShorts data={data} />
                <Today data={data} />
              </div>
            </>
          )}
        </>
      )}
      {mode === 'overview' ? (
        <Link className="analytics-deep-link" to="/analytics">
          Open the full analytics workspace <ArrowRight size={15} />
        </Link>
      ) : null}
    </section>
  );
}

export function ShortAnalyticsSummary({ shortId }: { shortId: string }) {
  const [data, setData] = useState<{
    publication: null | {
      videoId: string | null;
      state: string;
      publishAt: string;
      lastVerifiedAt: string | null;
    };
    totals: Totals;
    estimatedRevenueUsd: number | null;
  } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    api<NonNullable<typeof data>>(`/analytics/shorts/${shortId}`)
      .then((value) => current && setData(value))
      .catch(
        (reason) =>
          current &&
          setError(reason instanceof Error ? reason.message : 'Analytics could not be loaded.'),
      );
    return () => {
      current = false;
    };
  }, [shortId]);
  return (
    <section className="panel short-analytics" aria-labelledby="short-analytics-title">
      <div className="panel-heading">
        <div>
          <h2 id="short-analytics-title">YouTube performance</h2>
          <span className="muted">Lifetime captured snapshots</span>
        </div>
        {data?.publication ? (
          <Badge variant="outline" data-status={data.publication.state.toLowerCase()}>
            {stateLabel(data.publication.state)}
          </Badge>
        ) : null}
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : !data ? (
        <div className="analytics-loading pad">
          <Skeleton className="h-20 w-full" />
        </div>
      ) : !data.publication ? (
        <p className="analytics-inline-empty">
          Analytics becomes available after this Short is scheduled and receives a YouTube video ID.
        </p>
      ) : (
        <div className="short-analytics-grid">
          <Metric
            label="Views"
            value={number(data.totals.views)}
            detail={`${number(data.totals.engagedViews)} engaged`}
            icon={Eye}
          />
          <Metric
            label="Watch time"
            value={number(data.totals.watchMinutes, ' min')}
            detail={`${number(data.totals.averageViewPercentage, '%')} average viewed`}
            icon={Clock3}
          />
          <Metric
            label="Engagement"
            value={number(data.totals.likes)}
            detail={`${number(data.totals.comments)} comments · ${number(data.totals.shares)} shares`}
            icon={ThumbsUp}
          />
          <Metric
            label="Subscribers"
            value={number(data.totals.subscribersGained)}
            detail="Gained from this Short"
            icon={Users}
          />
          <Metric
            label="Est. revenue"
            value={money(data.estimatedRevenueUsd, 'USD')}
            detail="YouTube estimate · USD"
            icon={WalletCards}
          />
        </div>
      )}
    </section>
  );
}
