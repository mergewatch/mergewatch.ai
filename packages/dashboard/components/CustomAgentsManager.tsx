"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, AlertTriangle } from "lucide-react";
import type { OrgCustomAgent } from "@mergewatch/core";

interface Props {
  installationId: string;
  isAdmin: boolean;
  repos: string[];
}

type Draft = OrgCustomAgent;

function blankAgent(): Draft {
  return {
    id: "",
    name: "",
    prompt: "",
    severityDefault: "warning",
    enforcement: "advisory",
    enabled: true,
    scope: { mode: "all" },
    updatedAt: "",
    updatedBy: "",
  };
}

export default function CustomAgentsManager({ installationId, isAdmin, repos }: Props) {
  const [agents, setAgents] = useState<Draft[]>([]);
  const [softCap, setSoftCap] = useState(10);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/custom-agents?installation_id=${installationId}`);
        if (res.status === 401) { window.location.href = "/signout"; return; }
        if (!res.ok) throw new Error("Failed to load custom agents");
        const json = await res.json();
        if (!cancelled) {
          setAgents(json.agents ?? []);
          setSoftCap(json.softCap ?? 10);
        }
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [installationId]);

  const enabledCount = useMemo(() => agents.filter((a) => a.enabled).length, [agents]);
  const overCap = enabledCount > softCap;

  function update(i: number, patch: Partial<Draft>) {
    setAgents((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
    setSavedAt(null);
  }

  function addAgent() {
    setAgents((prev) => [...prev, blankAgent()]);
    setSavedAt(null);
  }

  function removeAgent(i: number) {
    setAgents((prev) => prev.filter((_, idx) => idx !== i));
    setSavedAt(null);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // Drop entries missing a name/prompt before saving (the API sanitizes too).
      const payload = agents.filter((a) => a.name.trim() && a.prompt.trim());
      const res = await fetch(`/api/custom-agents?installation_id=${installationId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agents: payload }),
      });
      if (res.status === 401) { window.location.href = "/signout"; return; }
      if (res.status === 403) throw new Error("Only org admins can edit custom agents.");
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "Failed to save");
      const json = await res.json();
      setAgents(json.agents ?? payload);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e: any) {
      setError(e.message ?? "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="px-4 py-6 sm:px-8">
        <div className="h-6 w-48 animate-pulse rounded bg-surface-subtle" />
        <div className="mt-4 h-40 animate-pulse rounded-lg bg-surface-subtle" />
      </div>
    );
  }

  return (
    <div className="px-4 py-6 sm:px-8">
      <header className="mb-4">
        <h1 className="text-xl font-bold text-fg-primary">Custom Agents</h1>
        <p className="mt-1 text-sm text-fg-secondary">
          Org-wide review agents enforced across your repositories. Each runs in
          addition to the built-in agents and any repo&apos;s <code>.mergewatch.yml</code>.
          {" "}Set an agent to <strong>blocking</strong> to fail the check run and request
          changes when it flags a critical issue.
        </p>
      </header>

      {!isAdmin && (
        <div className="mb-4 rounded-md border border-border-default bg-surface-subtle p-3 text-sm text-fg-secondary">
          You have read-only access. Only organization admins can add or edit custom agents.
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-500">
          {error}
        </div>
      )}

      {overCap && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm text-fg-secondary">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500" />
          <span>
            {enabledCount} agents enabled — above the recommended {softCap}. Each agent adds an
            LLM call per review, increasing latency and cost.
          </span>
        </div>
      )}

      <div className="space-y-4">
        {agents.length === 0 && (
          <div className="rounded-lg border border-border-default bg-surface-card p-8 text-center text-sm text-fg-secondary">
            No custom agents yet.{isAdmin ? " Add one to enforce an org-wide review standard." : ""}
          </div>
        )}

        {agents.map((a, i) => (
          <AgentCard
            key={a.id || `new-${i}`}
            agent={a}
            repos={repos}
            disabled={!isAdmin}
            onChange={(patch) => update(i, patch)}
            onRemove={() => removeAgent(i)}
          />
        ))}
      </div>

      {isAdmin && (
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={addAgent}
            className="inline-flex items-center gap-1.5 rounded-md border border-border-default bg-surface-card px-3 py-1.5 text-sm text-fg-primary transition hover:bg-hover"
          >
            <Plus className="h-4 w-4" /> Add agent
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-md bg-accent-emphasis px-4 py-1.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
          {savedAt && <span className="text-xs text-fg-tertiary">Saved at {savedAt}</span>}
        </div>
      )}
    </div>
  );
}

function AgentCard({
  agent,
  repos,
  disabled,
  onChange,
  onRemove,
}: {
  agent: Draft;
  repos: string[];
  disabled: boolean;
  onChange: (patch: Partial<Draft>) => void;
  onRemove: () => void;
}) {
  const [repoFilter, setRepoFilter] = useState("");
  const inputCls =
    "rounded-md border border-border-default bg-surface-card px-2 py-1.5 text-sm text-fg-primary focus:border-accent-emphasis focus:outline-none focus:ring-1 focus:ring-accent-emphasis disabled:opacity-60";

  const selectedRepos = agent.scope.mode === "selected" ? agent.scope.repos : [];
  const filteredRepos = repoFilter
    ? repos.filter((r) => r.toLowerCase().includes(repoFilter.toLowerCase()))
    : repos;

  function toggleRepo(repo: string) {
    const set = new Set(selectedRepos);
    if (set.has(repo)) set.delete(repo); else set.add(repo);
    onChange({ scope: { mode: "selected", repos: Array.from(set) } });
  }

  return (
    <div className="rounded-lg border border-border-default bg-surface-card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <input
          className={`${inputCls} flex-1 font-medium`}
          placeholder="Agent name (e.g. No console.log)"
          value={agent.name}
          disabled={disabled}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        {!disabled && (
          <button type="button" onClick={onRemove} className="p-1.5 text-fg-tertiary transition hover:text-red-500" aria-label="Remove agent">
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      <textarea
        className={`${inputCls} mt-3 w-full`}
        rows={3}
        placeholder="Prompt — what should this agent look for?"
        value={agent.prompt}
        disabled={disabled}
        onChange={(e) => onChange({ prompt: e.target.value })}
      />

      <div className="mt-3 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-1.5 text-sm text-fg-secondary">
          Severity
          <select className={inputCls} value={agent.severityDefault} disabled={disabled}
            onChange={(e) => onChange({ severityDefault: e.target.value as Draft["severityDefault"] })}>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </label>

        <label className="flex items-center gap-1.5 text-sm text-fg-secondary">
          Enforcement
          <select className={inputCls} value={agent.enforcement} disabled={disabled}
            onChange={(e) => onChange({ enforcement: e.target.value as Draft["enforcement"] })}>
            <option value="advisory">Advisory</option>
            <option value="blocking">Blocking</option>
          </select>
        </label>

        <label className="flex items-center gap-1.5 text-sm text-fg-secondary">
          <input type="checkbox" checked={agent.enabled} disabled={disabled}
            onChange={(e) => onChange({ enabled: e.target.checked })} />
          Enabled
        </label>
      </div>

      {/* Scope */}
      <div className="mt-3">
        <p className="mb-1 text-xs font-medium uppercase tracking-wider text-fg-tertiary">Applies to</p>
        <div className="flex gap-4 text-sm text-fg-secondary">
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={agent.scope.mode === "all"} disabled={disabled}
              onChange={() => onChange({ scope: { mode: "all" } })} />
            All repositories
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={agent.scope.mode === "selected"} disabled={disabled}
              onChange={() => onChange({ scope: { mode: "selected", repos: selectedRepos } })} />
            Selected repositories
          </label>
        </div>
        {agent.scope.mode === "selected" && (
          <div className="mt-2 rounded-md border border-border-default p-2">
            <input className={`${inputCls} mb-2 w-full`} placeholder="Filter repositories…"
              value={repoFilter} disabled={disabled} onChange={(e) => setRepoFilter(e.target.value)} />
            <div className="max-h-40 overflow-y-auto">
              {filteredRepos.length === 0 && <p className="px-1 py-2 text-xs text-fg-tertiary">No repositories.</p>}
              {filteredRepos.map((r) => (
                <label key={r} className="flex items-center gap-1.5 px-1 py-0.5 text-sm text-fg-primary">
                  <input type="checkbox" checked={selectedRepos.includes(r)} disabled={disabled}
                    onChange={() => toggleRepo(r)} />
                  {r}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-fg-tertiary">{selectedRepos.length} selected</p>
          </div>
        )}
      </div>

      {/* Targeting */}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-sm text-fg-secondary">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-fg-tertiary">Path globs (optional)</span>
          <input className={`${inputCls} w-full`} placeholder="src/api/**, **/*.ts" disabled={disabled}
            value={(agent.targeting?.pathGlobs ?? []).join(", ")}
            onChange={(e) => onChange({ targeting: mergeTargeting(agent, "pathGlobs", e.target.value) })} />
        </label>
        <label className="text-sm text-fg-secondary">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-fg-tertiary">Languages (optional)</span>
          <input className={`${inputCls} w-full`} placeholder="typescript, go" disabled={disabled}
            value={(agent.targeting?.languages ?? []).join(", ")}
            onChange={(e) => onChange({ targeting: mergeTargeting(agent, "languages", e.target.value) })} />
        </label>
      </div>

      {agent.updatedBy && (
        <p className="mt-3 text-xs text-fg-tertiary">
          Last edited by {agent.updatedBy}
          {agent.updatedAt ? ` · ${new Date(agent.updatedAt).toLocaleString()}` : ""}
        </p>
      )}
    </div>
  );
}

/** Parse a comma-separated list into a targeting field; omit targeting when both empty. */
function mergeTargeting(
  agent: Draft,
  field: "pathGlobs" | "languages",
  raw: string,
): Draft["targeting"] {
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const next = {
    pathGlobs: field === "pathGlobs" ? list : agent.targeting?.pathGlobs ?? [],
    languages: field === "languages" ? list : agent.targeting?.languages ?? [],
  };
  if (next.pathGlobs.length === 0 && next.languages.length === 0) return undefined;
  return {
    ...(next.pathGlobs.length ? { pathGlobs: next.pathGlobs } : {}),
    ...(next.languages.length ? { languages: next.languages } : {}),
  };
}
