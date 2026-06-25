export default function AnalyticsLoading() {
  return (
    <div className="px-4 py-6 sm:px-8">
      {/* Title */}
      <div className="mb-4 h-7 w-32 animate-pulse rounded bg-surface-subtle" />

      {/* Tab bar skeleton */}
      <div className="flex gap-1 border-b border-border-default">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="px-3 py-2">
            <div className="h-4 w-16 animate-pulse rounded bg-surface-subtle" />
          </div>
        ))}
      </div>

      {/* Filter bar skeleton */}
      <div className="mt-4 flex flex-wrap gap-2 sm:justify-end">
        <div className="h-9 w-40 animate-pulse rounded-lg bg-surface-subtle" />
        <div className="h-9 w-32 animate-pulse rounded-lg bg-surface-subtle" />
      </div>

      {/* Stat cards skeleton (Overview default) */}
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4 mb-6">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="rounded-lg border border-border-default bg-surface-card p-4">
            <div className="h-3 w-20 animate-pulse rounded bg-surface-subtle" />
            <div className="mt-2 h-7 w-16 animate-pulse rounded bg-surface-subtle" />
          </div>
        ))}
      </div>

      {/* Chart cards skeleton */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[...Array(2)].map((_, i) => (
          <div key={i} className="rounded-lg border border-border-default bg-surface-card p-4">
            <div className="h-4 w-32 animate-pulse rounded bg-surface-subtle" />
            <div className="mt-4 h-48 animate-pulse rounded bg-surface-subtle opacity-50" />
          </div>
        ))}
      </div>
    </div>
  );
}
