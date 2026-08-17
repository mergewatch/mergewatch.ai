"use client";

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import {
  ExternalLink,
  Search,
  GitBranch,
  Clock,
  Loader2,
} from "lucide-react";
import RelativeTime from "@/components/RelativeTime";

export interface RepositoryView {
  fullName: string;
  githubUrl: string;
  language: string | null;
  isPrivate: boolean;
  reviewCount: number;
  issueCount: number;
  lastReviewedAt: string | null;
  installationId: string;
}

interface RepositoriesClientProps {
  isAdmin: boolean;
  installationId: string;
  githubAppSlug?: string;
}

const PER_PAGE = 30;

export default function RepositoriesClient({
  isAdmin,
  installationId,
  githubAppSlug,
}: RepositoriesClientProps) {
  const [repos, setRepos] = useState<RepositoryView[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [languageFilter, setLanguageFilter] = useState<string>("all");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Infinite scroll sentinel
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Fetch a page of repos
  const fetchPage = useCallback(
    async (pageNum: number, append: boolean) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          installation_id: installationId,
          page: String(pageNum),
          per_page: String(PER_PAGE),
        });
        const res = await fetch(`/api/repositories?${params}`);
        if (!res.ok) return;

        const data = await res.json();
        const incoming: RepositoryView[] = data.repos ?? [];

        setRepos((prev) => (append ? [...prev, ...incoming] : incoming));
        setTotalCount(data.totalCount ?? 0);
        setHasMore(data.hasMore ?? false);
        setPage(pageNum);
      } finally {
        setLoading(false);
        setInitialLoad(false);
      }
    },
    [installationId],
  );

  // Initial load
  useEffect(() => {
    fetchPage(1, false);
  }, [fetchPage]);

  // Intersection observer for infinite scroll
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading) {
          fetchPage(page + 1, true);
        }
      },
      { rootMargin: "200px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, page, fetchPage]);

  // Debounced search (client-side filtering)
  const handleSearch = useCallback((value: string) => {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(value);
    }, 200);
  }, []);

  // Unique languages from loaded repos
  const languages = useMemo(() => {
    const langs = new Set<string>();
    repos.forEach((r) => {
      if (r.language) langs.add(r.language);
    });
    return Array.from(langs).sort();
  }, [repos]);

  // Client-side filtering
  const filtered = useMemo(() => {
    let result = repos;

    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      result = result.filter((r) => r.fullName.toLowerCase().includes(q));
    }

    if (statusFilter === "no-reviews") {
      result = result.filter((r) => r.reviewCount === 0);
    }

    if (languageFilter !== "all") {
      result = result.filter((r) => r.language === languageFilter);
    }

    return result;
  }, [repos, debouncedSearch, statusFilter, languageFilter]);

  const clearFilters = useCallback(() => {
    setSearch("");
    setDebouncedSearch("");
    setStatusFilter("all");
    setLanguageFilter("all");
  }, []);

  const githubConfigUrl = githubAppSlug
    ? `https://github.com/apps/${githubAppSlug}/installations/${installationId}`
    : `https://github.com/settings/installations/${installationId}`;

  const hasFilters = debouncedSearch || statusFilter !== "all" || languageFilter !== "all";

  return (
    <div>
      {/* Header */}
      <div className="px-4 pt-6 pb-5 border-b border-border-default flex items-start justify-between sm:px-8 sm:pt-8 sm:pb-6">
        <div>
          <h1 className="text-fg-primary text-xl font-semibold">Repositories</h1>
          <p className="text-fg-tertiary text-sm mt-1">
            All repositories with MergeWatch installed.
          </p>
        </div>
        {isAdmin && (
          <a
            href={githubConfigUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-card-hover border border-[#2a2a2a] rounded-md text-sm text-fg-secondary hover:text-fg-primary hover:border-fg-faint transition-colors"
          >
            Configure on GitHub
            <ExternalLink size={12} />
          </a>
        )}
      </div>

      {/* Summary strip */}
      <div className="flex items-center gap-6 px-4 py-4 border-b border-border-default sm:px-8">
        <div className="flex items-baseline gap-1.5">
          <span className="text-fg-primary text-lg font-semibold tabular-nums">
            {initialLoad ? "–" : totalCount}
          </span>
          <span className="text-fg-muted text-sm">connected</span>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-col gap-3 px-4 py-4 border-b border-border-default sm:flex-row sm:items-center sm:px-8">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted"
          />
          <input
            type="text"
            placeholder="Search repos..."
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-8 pr-3 py-1.5 bg-surface-card-hover border border-[#2a2a2a] rounded-md text-sm text-fg-primary placeholder-fg-muted w-52 focus:outline-none focus:border-accent-green/40"
          />
        </div>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-1.5 bg-surface-card-hover border border-[#2a2a2a] rounded-md text-sm text-fg-secondary focus:outline-none focus:border-accent-green/40"
        >
          <option value="all">All</option>
          <option value="no-reviews">No reviews yet</option>
        </select>

        {languages.length > 0 && (
          <select
            value={languageFilter}
            onChange={(e) => setLanguageFilter(e.target.value)}
            className="px-3 py-1.5 bg-surface-card-hover border border-[#2a2a2a] rounded-md text-sm text-fg-secondary focus:outline-none focus:border-accent-green/40"
          >
            <option value="all">All languages</option>
            {languages.map((lang) => (
              <option key={lang} value={lang}>
                {lang}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Content */}
      {initialLoad ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 size={24} className="animate-spin text-fg-faint" />
        </div>
      ) : repos.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <GitBranch size={32} className="text-[#2a2a2a] mb-4" />
          <div className="text-fg-primary text-sm font-medium">
            No repositories connected
          </div>
          <div className="text-fg-muted text-xs mt-1 max-w-xs leading-relaxed">
            MergeWatch doesn&apos;t have access to any repositories yet.
            Configure the GitHub App installation to select repos.
          </div>
          {isAdmin && (
            <a
              href={githubConfigUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 flex items-center gap-1.5 px-3 py-1.5 bg-surface-card-hover border border-[#2a2a2a] rounded-md text-sm text-fg-secondary hover:text-fg-primary transition-colors"
            >
              Configure on GitHub <ExternalLink size={12} />
            </a>
          )}
        </div>
      ) : filtered.length === 0 && hasFilters ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Search size={28} className="text-[#2a2a2a] mb-4" />
          <div className="text-fg-primary text-sm font-medium">
            No repos match your filters
          </div>
          <button
            onClick={clearFilters}
            className="mt-3 text-xs text-accent-green hover:underline"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 p-4 sm:p-8">
            {filtered.map((repo) => (
              <RepoCard
                key={repo.fullName}
                repo={repo}
              />
            ))}
          </div>

          {/* Infinite scroll sentinel */}
          <div ref={sentinelRef} className="h-1" />

          {/* Loading indicator */}
          {loading && !initialLoad && (
            <div className="flex items-center justify-center py-6">
              <Loader2 size={20} className="animate-spin text-fg-faint" />
              <span className="ml-2 text-xs text-fg-muted">Loading more repos...</span>
            </div>
          )}

          {/* End of list */}
          {!hasMore && repos.length > PER_PAGE && (
            <div className="text-center py-6 text-xs text-fg-faint">
              All {totalCount} repositories loaded
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RepoCard
// ---------------------------------------------------------------------------

function RepoCard({
  repo,
}: {
  repo: RepositoryView;
}) {
  return (
    <div className="bg-surface-card-hover border border-border-default rounded-lg p-5 hover:border-[#2a2a2a] transition-colors">
      {/* Header row */}
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0">
          <a
            href={repo.githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-fg-primary text-sm font-medium hover:text-accent-green transition-colors flex items-center gap-1.5 group"
          >
            {repo.fullName}
            <ExternalLink
              size={11}
              className="text-fg-faint group-hover:text-accent-green transition-colors"
            />
          </a>
          <div className="flex items-center gap-2 mt-1">
            {repo.language && (
              <span className="text-fg-muted text-xs">{repo.language}</span>
            )}
            {repo.language && (
              <span className="text-[#222] text-xs">&middot;</span>
            )}
            <span className="text-fg-muted text-xs">
              {repo.isPrivate ? "Private" : "Public"}
            </span>
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-border-subtle mb-3" />

      {/* Status */}
      <RepoStatus repo={repo} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// RepoStatus
// ---------------------------------------------------------------------------

function RepoStatus({ repo }: { repo: RepositoryView }) {
  if (repo.reviewCount === 0) {
    return (
      <div className="flex items-center gap-2 py-1">
        <Clock size={13} className="text-fg-faint" />
        <span className="text-fg-muted text-xs">
          No reviews yet — open a PR to trigger the first one.
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-fg-tertiary text-xs">Reviews</span>
        <span className="text-fg-secondary text-xs tabular-nums">
          {repo.reviewCount}
        </span>
      </div>
      {repo.issueCount > 0 && (
        <div className="flex items-center justify-between">
          <span className="text-fg-tertiary text-xs">Issues caught</span>
          <span className="text-fg-secondary text-xs tabular-nums">
            {repo.issueCount}
          </span>
        </div>
      )}
      {repo.lastReviewedAt && (
        <div className="flex items-center justify-between">
          <span className="text-fg-tertiary text-xs">Last review</span>
          <span className="text-fg-secondary text-xs">
            <RelativeTime date={repo.lastReviewedAt} />
          </span>
        </div>
      )}
      <div className="flex items-center gap-1.5 mt-2">
        <span className="w-1.5 h-1.5 rounded-full bg-accent-green" />
        <span className="text-accent-green text-xs">Active</span>
      </div>
    </div>
  );
}
