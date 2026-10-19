'use client'

import { useState, useEffect, useCallback } from 'react'
import { useMissionControl } from '@/store'

interface CatalogEntry {
  id: string
  title?: string
  description?: string
  excerpt?: string
  role?: string
  model?: string
  parseError?: string
}

interface SectionPayload {
  entries: CatalogEntry[]
  unavailable?: true
  message?: string
}

interface CatalogData {
  workspaces?: SectionPayload
  roster?: SectionPayload
  commands?: SectionPayload
}

interface WaveEntry {
  key: string
  status: 'active' | 'completed' | 'draft'
  excerpt?: string
  mtime?: number
  hasCompletedRecord?: boolean
  parseError?: string
}

interface WavesData {
  waves: WaveEntry[]
  active: { waveKey: string } | null
  unavailable?: true
  message?: string
}

const STATUS_STYLES: Record<string, string> = {
  idle: 'bg-green-500/10 text-green-400',
  busy: 'bg-blue-500/10 text-blue-400',
  offline: 'bg-muted text-muted-foreground',
  error: 'bg-destructive/10 text-destructive',
  unknown: 'bg-yellow-500/10 text-yellow-400',
}

export function AiTeamPanel() {
  const { agents, setAgents } = useMissionControl()
  const [catalog, setCatalog] = useState<CatalogData | null>(null)
  const [waves, setWaves] = useState<WavesData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchAiTeam = useCallback(async () => {
    try {
      const [catalogRes, wavesRes, agentsRes] = await Promise.all([
        fetch('/api/ai-team/catalog'),
        fetch('/api/ai-team/waves', { cache: 'no-store' }),
        fetch('/api/agents'),
      ])
      if (catalogRes.status === 403 || wavesRes.status === 403) {
        setError('Access restricted')
        return
      }
      if (catalogRes.status === 404) {
        const data = await catalogRes.json().catch(() => ({}))
        setError(data.error || 'AI team catalog not found')
        return
      }
      if (!catalogRes.ok || !wavesRes.ok) {
        setError('Failed to load AI team data')
        return
      }
      const [catalogData, wavesData] = await Promise.all([
        catalogRes.json(),
        wavesRes.json(),
      ])
      setCatalog(catalogData)
      setWaves(wavesData)
      // Seed the shared agents slice so the roster live-status column
      // joins against fresh data; absence is fine (renders `unknown`).
      if (agentsRes.ok) {
        const agentsData = await agentsRes.json().catch(() => ({}))
        if (agentsData.agents) setAgents(agentsData.agents)
      }
    } catch {
      setError('Failed to load AI team data')
    } finally {
      setLoading(false)
    }
  }, [setAgents])

  useEffect(() => { fetchAiTeam() }, [fetchAiTeam])

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2">
        <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        <span className="text-sm text-muted-foreground">Loading AI team...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-destructive/10 text-destructive rounded-lg p-4 text-sm">{error}</div>
      </div>
    )
  }

  const liveByName = new Map((agents || []).map((a) => [a.name, a]))

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">AI Team</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Read-only view of the workspaces, agent roster, wave history, and command catalog.
        </p>
      </div>

      {/* Workspaces */}
      <section className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-sm font-medium text-foreground">Workspaces</h3>
        </div>
        <div className="px-4 py-3">
          {!catalog?.workspaces || catalog.workspaces.entries.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {catalog?.workspaces?.message || 'No workspaces available.'}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {catalog.workspaces.entries.map((entry) => (
                <li key={entry.id} className="flex items-baseline gap-2 py-1">
                  <span className="text-sm font-medium text-foreground">{entry.title || entry.id}</span>
                  {entry.excerpt && (
                    <span className="text-xs text-muted-foreground truncate">{entry.excerpt}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Roster */}
      <section className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-sm font-medium text-foreground">Roster</h3>
        </div>
        <div className="px-4 py-3">
          {!catalog?.roster || catalog.roster.entries.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {catalog?.roster?.message || 'No roster entries available.'}
            </p>
          ) : (
            <ul className="divide-y divide-border/50">
              {catalog.roster.entries.map((entry) => {
                const live = liveByName.get(entry.title || entry.id) || liveByName.get(entry.id)
                const status = live?.status || 'unknown'
                return (
                  <li key={entry.id} className="flex items-center gap-3 py-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">
                        {entry.title || entry.id}
                      </div>
                      {entry.parseError ? (
                        <div className="text-xs text-destructive">parse error: {entry.parseError}</div>
                      ) : (
                        entry.description && (
                          <div className="text-xs text-muted-foreground truncate" title={entry.description}>
                            {entry.description}
                          </div>
                        )
                      )}
                    </div>
                    {entry.role && (
                      <span className="text-2xs text-muted-foreground shrink-0">{entry.role}</span>
                    )}
                    <span
                      className={`text-2xs font-medium px-2 py-0.5 rounded-full shrink-0 ${STATUS_STYLES[status] || STATUS_STYLES.unknown}`}
                    >
                      {status}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </section>

      {/* Waves */}
      <section className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-sm font-medium text-foreground">Waves</h3>
        </div>
        <div className="px-4 py-3">
          {!waves || waves.waves.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {waves?.message || 'No waves recorded yet.'}
            </p>
          ) : (
            <ul className="divide-y divide-border/50">
              {waves.waves.map((wave) => (
                <li key={wave.key} className="flex items-center gap-3 py-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground font-mono truncate">{wave.key}</div>
                    {wave.parseError ? (
                      <div className="text-xs text-destructive">parse error: {wave.parseError}</div>
                    ) : (
                      wave.excerpt && (
                        <div className="text-xs text-muted-foreground truncate" title={wave.excerpt}>
                          {wave.excerpt}
                        </div>
                      )
                    )}
                  </div>
                  <span
                    className={`text-2xs font-medium px-2 py-0.5 rounded-full shrink-0 ${
                      wave.status === 'active'
                        ? 'bg-green-500/10 text-green-400'
                        : wave.status === 'completed'
                          ? 'bg-muted text-muted-foreground'
                          : 'bg-blue-500/10 text-blue-400'
                    }`}
                  >
                    {wave.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Commands */}
      <section className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-sm font-medium text-foreground">Commands</h3>
        </div>
        <div className="px-4 py-3">
          {!catalog?.commands || catalog.commands.entries.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {catalog?.commands?.message || 'No commands available.'}
            </p>
          ) : (
            <ul className="divide-y divide-border/50">
              {catalog.commands.entries.map((entry) => (
                <li key={entry.id} className="py-2">
                  <div className="text-sm font-medium text-foreground font-mono">{entry.title || entry.id}</div>
                  {entry.parseError ? (
                    <div className="text-xs text-destructive">parse error: {entry.parseError}</div>
                  ) : (
                    entry.excerpt && (
                      <div className="text-xs text-muted-foreground line-clamp-2" title={entry.excerpt}>
                        {entry.excerpt}
                      </div>
                    )
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}
