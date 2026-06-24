"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import ImpactPanel from "./insights/ImpactPanel";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  Legend,
} from "recharts";

// -- Types ------------------------------------------------------------------

interface ScoreTrendPoint {
  date: string;
  avgScore: number;
  count: number;
}

interface FindingsPerReviewPoint {
  date: string;
  avgFindings: number;
  count: number;
}

interface RepoBreakdownItem {
  repo: string;
  count: number;
}

interface AnalyticsData {
  totalReviews: number;
  totalFindings: number;
  avgMergeScore: number;
  scoreTrend: ScoreTrendPoint[];
  severityBreakdown: Record<string, number>;
  durationStats: { avgMs: number; p95Ms: number; count: number };
  repoBreakdown: RepoBreakdownItem[];
  categoryBreakdown: Record<string, number>;
  statusCounts: Record<string, number>;
  findingsPerReviewTrend: FindingsPerReviewPoint[];
  mergeScoreDistribution: Record<number, number>;
}

interface AnalyticsClientProps {
  installationId: string;
}

// -- Constants ---------------------------------------------------------------

const CHART_COLORS = {
  green: "#22c55e",
  yellow: "#eab308",
  red: "#ef4444",
  blue: "#3b82f6",
  purple: "#8b5cf6",
  orange: "#f97316",
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: CHART_COLORS.red,
  warning: CHART_COLORS.yellow,
  info: CHART_COLORS.blue,
};

const CATEGORY_COLORS: Record<string, string> = {
  security: CHART_COLORS.red,
  bug: CHART_COLORS.orange,
  style: CHART_COLORS.purple,
  'error-handling': CHART_COLORS.yellow,
  'test-coverage': CHART_COLORS.blue,
  'comment-accuracy': CHART_COLORS.green,
};

const STATUS_COLORS: Record<string, string> = {
  complete: CHART_COLORS.green,
  failed: CHART_COLORS.red,
  skipped: CHART_COLORS.yellow,
  pending: CHART_COLORS.blue,
  in_progress: CHART_COLORS.orange,
};

const SCORE_DIST_COLORS: Record<number, string> = {
  1: CHART_COLORS.red,
  2: CHART_COLORS.orange,
  3: CHART_COLORS.yellow,
  4: CHART_COLORS.blue,
  5: CHART_COLORS.green,
};

// -- Helpers -----------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// -- Time range presets ------------------------------------------------------

type TimeRangeKey = "24h" | "3d" | "7d" | "30d" | "1y" | "custom";

const TIME_RANGE_OPTIONS: { key: TimeRangeKey; label: string }[] = [
  { key: "24h", label: "Last 24 hours" },
  { key: "3d", label: "Last 3 days" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "1y", label: "Last year" },
  { key: "custom", label: "Custom range" },
];

function getDateRange(key: TimeRangeKey, customStart?: string, customEnd?: string): { startDate: string; endDate: string } {
  const now = new Date();
  const endDate = now.toISOString();

  if (key === "custom" && customStart && customEnd) {
    return {
      startDate: new Date(customStart + "T00:00:00Z").toISOString(),
      endDate: new Date(customEnd + "T23:59:59.999Z").toISOString(),
    };
  }

  const msPerDay = 86400000;
  const offsets: Record<string, number> = {
    "24h": 1,
    "3d": 3,
    "7d": 7,
    "30d": 30,
    "1y": 365,
  };
  const days = offsets[key] ?? 30;
  const startDate = new Date(now.getTime() - days * msPerDay).toISOString();
  return { startDate, endDate };
}

// -- Sub-components ----------------------------------------------------------

function StatCard({ label, value, subtext }: { label: string; value: string | number; subtext?: string }) {
  return (
    <div className="rounded-lg border border-border-default bg-surface-card p-4 sm:p-5">
      <p className="text-xs font-medium uppercase tracking-wider text-fg-tertiary">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold text-fg-primary">
        {value}
      </p>
      {subtext && (
        <p className="mt-0.5 text-xs text-fg-secondary">
          {subtext}
        </p>
      )}
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border-default bg-surface-card p-4 sm:p-5">
      <h3 className="mb-4 text-sm font-semibold text-fg-primary">
        {title}
      </h3>
      {children}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="animate-pulse rounded-lg border border-border-default bg-surface-card p-4 sm:p-5">
      <div className="h-3 w-20 rounded bg-border-default" />
      <div className="mt-3 h-7 w-16 rounded bg-border-default" />
    </div>
  );
}

function SkeletonChartCard() {
  return (
    <div className="animate-pulse rounded-lg border border-border-default bg-surface-card p-4 sm:p-5">
      <div className="h-4 w-32 rounded bg-border-default" />
      <div className="mt-6 h-48 w-full rounded bg-border-default opacity-50" />
    </div>
  );
}

// -- Custom Tooltip ----------------------------------------------------------

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border border-border-default bg-surface-elevated px-3 py-2 text-xs text-fg-primary shadow-lg">
      <p className="font-medium">{label}</p>
      {payload.map((entry: any, i: number) => (
        <p key={i} style={{ color: entry.color }}>
          {entry.name}: {entry.value}
        </p>
      ))}
    </div>
  );
}

// -- Searchable Select -------------------------------------------------------

function SearchableRepoSelect({
  value,
  onChange,
  repos,
}: {
  value: string;
  onChange: (value: string) => void;
  repos: string[];
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  const filtered = search
    ? repos.filter((r) => r.toLowerCase().includes(search.toLowerCase()))
    : repos;

  const displayLabel = value === "all"
    ? "All repositories"
    : value.includes("/") ? value.split("/")[1] : value;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md border border-border-default bg-surface-card py-1.5 pl-3 pr-8 text-sm text-fg-primary focus:border-accent-emphasis focus:outline-none focus:ring-1 focus:ring-accent-emphasis"
      >
        <span className="max-w-[160px] truncate">{displayLabel}</span>
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-tertiary" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-64 rounded-md border border-border-default bg-surface-elevated shadow-lg">
          <div className="flex items-center gap-2 border-b border-border-default px-3 py-2">
            <Search className="h-3.5 w-3.5 text-fg-tertiary" />
            <input
              ref={inputRef}
              type="text"
              placeholder="Search repositories..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 bg-transparent text-sm text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
            />
            {search && (
              <button type="button" onClick={() => setSearch("")} className="text-fg-tertiary hover:text-fg-secondary">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="max-h-60 overflow-y-auto py-1">
            <button
              type="button"
              onClick={() => { onChange("all"); setOpen(false); setSearch(""); }}
              className={`w-full px-3 py-1.5 text-left text-sm hover:bg-surface-card ${value === "all" ? "font-medium text-accent-emphasis" : "text-fg-primary"}`}
            >
              All repositories
            </button>
            {filtered.map((repo) => (
              <button
                key={repo}
                type="button"
                onClick={() => { onChange(repo); setOpen(false); setSearch(""); }}
                className={`w-full px-3 py-1.5 text-left text-sm hover:bg-surface-card ${value === repo ? "font-medium text-accent-emphasis" : "text-fg-primary"}`}
              >
                <span className="text-fg-tertiary">{repo.split("/")[0]}/</span>
                {repo.split("/")[1] ?? repo}
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="px-3 py-2 text-xs text-fg-tertiary">No repositories found</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// -- Main Component ----------------------------------------------------------

export default function AnalyticsClient({ installationId }: AnalyticsClientProps) {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRangeKey>("7d");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<string>("all");
  const [availableRepos, setAvailableRepos] = useState<string[]>([]);

  const dateRange = useMemo(
    () => getDateRange(timeRange, customStart, customEnd),
    [timeRange, customStart, customEnd],
  );

  const invalidDateRange = timeRange === "custom" && customStart && customEnd && customEnd < customStart;

  useEffect(() => {
    // Don't fetch if custom range is incomplete or inverted
    if (timeRange === "custom" && (!customStart || !customEnd || customEnd < customStart)) return;

    let cancelled = false;

    async function fetchAnalytics() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          installation_id: installationId,
          start_date: dateRange.startDate,
          end_date: dateRange.endDate,
        });
        if (selectedRepo !== "all") {
          params.set("repo", selectedRepo);
        }
        const res = await fetch(`/api/analytics?${params}`);
        if (!res.ok) {
          if (res.status === 401) {
            window.location.href = "/signout";
            return;
          }
          throw new Error("Failed to fetch analytics");
        }
        const json = await res.json();
        if (!cancelled) {
          setData(json.analytics);
          if (json.availableRepos) {
            setAvailableRepos(json.availableRepos);
          }
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message ?? "Failed to load analytics");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchAnalytics();
    return () => { cancelled = true; };
  }, [installationId, dateRange, selectedRepo]);

  const filterBar = (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <h1 className="text-xl font-bold text-fg-primary">Analytics</h1>
      <div className="flex flex-wrap items-center gap-2">
        {availableRepos.length > 1 && (
          <SearchableRepoSelect
            value={selectedRepo}
            onChange={setSelectedRepo}
            repos={availableRepos}
          />
        )}
        <div className="relative">
          <select
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value as TimeRangeKey)}
            className="appearance-none rounded-md border border-border-default bg-surface-card py-1.5 pl-3 pr-8 text-sm text-fg-primary focus:border-accent-emphasis focus:outline-none focus:ring-1 focus:ring-accent-emphasis"
          >
            {TIME_RANGE_OPTIONS.map((opt) => (
              <option key={opt.key} value={opt.key}>{opt.label}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-tertiary" />
        </div>
        {timeRange === "custom" && (
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              className={`rounded-md border bg-surface-card px-2 py-1.5 text-sm text-fg-primary focus:outline-none focus:ring-1 ${invalidDateRange ? "border-red-500 focus:border-red-500 focus:ring-red-500" : "border-border-default focus:border-accent-emphasis focus:ring-accent-emphasis"}`}
            />
            <span className="text-xs text-fg-tertiary">to</span>
            <input
              type="date"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              className={`rounded-md border bg-surface-card px-2 py-1.5 text-sm text-fg-primary focus:outline-none focus:ring-1 ${invalidDateRange ? "border-red-500 focus:border-red-500 focus:ring-red-500" : "border-border-default focus:border-accent-emphasis focus:ring-accent-emphasis"}`}
            />
            {invalidDateRange && (
              <span className="text-xs text-red-500">End date must be after start date</span>
            )}
          </div>
        )}
      </div>
    </div>
  );

  // Loading state
  if (loading) {
    return (
      <div className="px-4 py-6 sm:px-8">
        {filterBar}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 mb-6">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
          <SkeletonChartCard />
          <SkeletonChartCard />
          <SkeletonChartCard />
          <SkeletonChartCard />
          <SkeletonChartCard />
          <SkeletonChartCard />
          <SkeletonChartCard />
          <SkeletonChartCard />
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="px-4 py-6 sm:px-8">
        {filterBar}
        <div className="rounded-lg border border-border-default bg-surface-card p-8 text-center">
          <p className="text-sm text-fg-secondary">{error}</p>
        </div>
      </div>
    );
  }

  // Empty state
  if (!data || data.totalReviews === 0) {
    return (
      <div className="px-4 py-6 sm:px-8">
        {filterBar}
        <div className="rounded-lg border border-border-default bg-surface-card p-12 text-center">
          <p className="text-base font-medium text-fg-primary">No review data yet</p>
          <p className="mt-2 text-sm text-fg-secondary">
            Analytics will appear here once MergeWatch has reviewed some pull requests.
          </p>
        </div>
      </div>
    );
  }

  // Prepare chart data
  const scoreTrendData = data.scoreTrend.map((p) => ({
    ...p,
    dateLabel: formatDateLabel(p.date),
  }));

  const severityData = Object.entries(data.severityBreakdown)
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => ({
      name: severity.charAt(0).toUpperCase() + severity.slice(1),
      value: count,
      color: SEVERITY_COLORS[severity] ?? CHART_COLORS.blue,
    }));

  const categoryData = Object.entries(data.categoryBreakdown)
    .filter(([, count]) => count > 0)
    .map(([category, count]) => ({
      name: category.charAt(0).toUpperCase() + category.slice(1),
      value: count,
      color: CATEGORY_COLORS[category] ?? CHART_COLORS.blue,
    }));

  const repoData = data.repoBreakdown.slice(0, 10).map((r) => ({
    name: r.repo.includes("/") ? r.repo.split("/")[1] : r.repo,
    fullName: r.repo,
    reviews: r.count,
  }));

  const durationData = [
    { name: "Average", value: Math.round(data.durationStats.avgMs / 1000), fill: CHART_COLORS.blue },
    { name: "P95", value: Math.round(data.durationStats.p95Ms / 1000), fill: CHART_COLORS.purple },
  ];

  // Review success rate
  const statusData = Object.entries(data.statusCounts)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => ({
      name: status === "in_progress" ? "In Progress" : status.charAt(0).toUpperCase() + status.slice(1),
      value: count,
      color: STATUS_COLORS[status] ?? CHART_COLORS.blue,
    }));
  const successRate = data.totalReviews > 0
    ? Math.round(((data.statusCounts.complete ?? 0) / data.totalReviews) * 100)
    : 0;

  // Findings per review trend
  const findingsTrendData = data.findingsPerReviewTrend.map((p) => ({
    ...p,
    dateLabel: formatDateLabel(p.date),
  }));

  // Merge score distribution
  const scoreDistData = [1, 2, 3, 4, 5].map((score) => ({
    name: String(score),
    label: score === 1 ? "1 (Risky)" : score === 5 ? "5 (Safe)" : String(score),
    value: data.mergeScoreDistribution[score] ?? 0,
    fill: SCORE_DIST_COLORS[score],
  })); // always show all 5 buckets for consistent x-axis

  return (
    <div className="px-4 py-6 sm:px-8">
      {filterBar}

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 mb-6">
        <StatCard label="Total Reviews" value={data.totalReviews} />
        <StatCard label="Total Findings" value={data.totalFindings} />
        <StatCard
          label="Avg Merge Score"
          value={data.avgMergeScore > 0 ? `${data.avgMergeScore} / 5` : "N/A"}
          subtext={data.avgMergeScore > 0 ? "Higher is better" : undefined}
        />
        <StatCard
          label="Success Rate"
          value={`${successRate}%`}
          subtext={`${data.statusCounts.complete ?? 0} completed, ${data.statusCounts.failed ?? 0} failed`}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {/* Score Trend */}
        {scoreTrendData.length > 0 && (
          <ChartCard title="Merge Score Trend">
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={scoreTrendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" />
                <XAxis
                  dataKey="dateLabel"
                  tick={{ fontSize: 11, fill: "var(--text-tertiary)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border-default)" }}
                />
                <YAxis
                  domain={[0, 5]}
                  tick={{ fontSize: 11, fill: "var(--text-tertiary)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border-default)" }}
                />
                <Tooltip content={<ChartTooltip />} />
                <Line
                  type="monotone"
                  dataKey="avgScore"
                  name="Avg Score"
                  stroke={CHART_COLORS.green}
                  strokeWidth={2}
                  dot={{ r: 3, fill: CHART_COLORS.green }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {/* Severity Breakdown */}
        {severityData.length > 0 && (
          <ChartCard title="Findings by Severity">
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie
                  data={severityData}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={4}
                  dataKey="value"
                  nameKey="name"
                  label={({ name, value }) => `${name}: ${value}`}
                >
                  {severityData.map((entry, index) => (
                    <Cell key={`severity-${index}`} fill={entry.color} stroke="var(--surface-card)" strokeWidth={2} />
                  ))}
                </Pie>
                <Tooltip content={<ChartTooltip />} />
              </PieChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {/* Review Duration */}
        {data.durationStats.count > 0 && (
          <ChartCard title="Review Duration">
            <div className="mb-3 flex gap-4">
              <div>
                <p className="text-xs text-fg-tertiary">Average</p>
                <p className="text-lg font-semibold text-fg-primary">
                  {formatDuration(data.durationStats.avgMs)}
                </p>
              </div>
              <div>
                <p className="text-xs text-fg-tertiary">P95</p>
                <p className="text-lg font-semibold text-fg-primary">
                  {formatDuration(data.durationStats.p95Ms)}
                </p>
              </div>
              <div>
                <p className="text-xs text-fg-tertiary">Completed</p>
                <p className="text-lg font-semibold text-fg-primary">
                  {data.durationStats.count}
                </p>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={durationData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fontSize: 11, fill: "var(--text-tertiary)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border-default)" }}
                  unit="s"
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fontSize: 11, fill: "var(--text-tertiary)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border-default)" }}
                  width={60}
                />
                <Tooltip
                  content={<ChartTooltip />}
                  formatter={(value: number) => [`${value}s`, "Duration"]}
                />
                <Bar dataKey="value" name="Duration" radius={[0, 4, 4, 0]}>
                  {durationData.map((entry, index) => (
                    <Cell key={`duration-${index}`} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {/* Reviews per Repo */}
        {repoData.length > 0 && (
          <ChartCard title="Reviews per Repository">
            <ResponsiveContainer width="100%" height={Math.max(180, repoData.length * 36)}>
              <BarChart data={repoData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fontSize: 11, fill: "var(--text-tertiary)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border-default)" }}
                  allowDecimals={false}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fontSize: 11, fill: "var(--text-tertiary)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border-default)" }}
                  width={120}
                />
                <Tooltip
                  content={<ChartTooltip />}
                  formatter={(value: number) => [value, "Reviews"]}
                />
                <Bar dataKey="reviews" name="Reviews" fill={CHART_COLORS.green} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {/* Category Breakdown */}
        {categoryData.length > 0 && (
          <ChartCard title="Findings by Category">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={categoryData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 11, fill: "var(--text-tertiary)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border-default)" }}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--text-tertiary)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border-default)" }}
                  allowDecimals={false}
                />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="value" name="Findings" radius={[4, 4, 0, 0]}>
                  {categoryData.map((entry, index) => (
                    <Cell key={`category-${index}`} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {/* Review Status Breakdown */}
        {statusData.length > 0 && (
          <ChartCard title="Review Status">
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie
                  data={statusData}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={4}
                  dataKey="value"
                  nameKey="name"
                  label={({ name, value }) => `${name}: ${value}`}
                >
                  {statusData.map((entry, index) => (
                    <Cell key={`status-${index}`} fill={entry.color} stroke="var(--surface-card)" strokeWidth={2} />
                  ))}
                </Pie>
                <Tooltip content={<ChartTooltip />} />
              </PieChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {/* Findings per Review Trend */}
        {findingsTrendData.length > 1 && (
          <ChartCard title="Findings per Review">
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={findingsTrendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" />
                <XAxis
                  dataKey="dateLabel"
                  tick={{ fontSize: 11, fill: "var(--text-tertiary)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border-default)" }}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--text-tertiary)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border-default)" }}
                  allowDecimals={false}
                />
                <Tooltip content={<ChartTooltip />} />
                <Line
                  type="monotone"
                  dataKey="avgFindings"
                  name="Avg Findings"
                  stroke={CHART_COLORS.orange}
                  strokeWidth={2}
                  dot={{ r: 3, fill: CHART_COLORS.orange }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {/* Merge Score Distribution */}
        {scoreDistData.some((d) => d.value > 0) && (
          <ChartCard title="Merge Score Distribution">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={scoreDistData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: "var(--text-tertiary)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border-default)" }}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--text-tertiary)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border-default)" }}
                  allowDecimals={false}
                />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="value" name="Reviews" radius={[4, 4, 0, 0]}>
                  {scoreDistData.map((entry, index) => (
                    <Cell key={`score-${index}`} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}
      </div>

      {/* Impact (value / ROI) — cost, cycle-time, engagement from the hourly rollup. */}
      <div className="mt-8 border-t border-border-default pt-8">
        <ImpactPanel installationId={installationId} />
      </div>
    </div>
  );
}
