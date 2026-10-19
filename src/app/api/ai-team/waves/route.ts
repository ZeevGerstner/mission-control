import { NextRequest, NextResponse } from 'next/server'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { requireRole } from '@/lib/auth'
import { resolveWithin } from '@/lib/paths'

const WAVE_ROOT = 'state/wave'
const EXCERPT_LEN = 280

export type WaveStatus = 'active' | 'completed' | 'draft'

export interface WaveEntry {
  key: string
  status: WaveStatus
  excerpt?: string
  mtime?: number
  hasCompletedRecord?: boolean
  parseError?: string
}

export interface ActiveWaveSummary {
  waveKey: string
  waveId?: string
  aiTeam?: boolean
  aiTeamVersion?: string
  orchestrationMode?: boolean
  decisionGateClosed?: boolean
  checkoutMode?: string
  skipLinear?: boolean
  updatedAt?: string
}

function excerpt(text: string, len = EXCERPT_LEN): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > len ? flat.slice(0, len) : flat
}

function readActiveSummary(rootAbs: string): { active: ActiveWaveSummary | null; parseError?: string } {
  const activePath = resolveWithin(rootAbs, 'active.json')
  if (!existsSync(activePath)) return { active: null }
  try {
    const parsed = JSON.parse(readFileSync(activePath, 'utf-8')) as Record<string, unknown>
    if (typeof parsed.waveKey !== 'string') return { active: null, parseError: 'active-missing-waveKey' }
    const summary: ActiveWaveSummary = { waveKey: parsed.waveKey }
    if (typeof parsed.waveId === 'string') summary.waveId = parsed.waveId
    if (typeof parsed.aiTeam === 'boolean') summary.aiTeam = parsed.aiTeam
    if (typeof parsed.aiTeamVersion === 'string') summary.aiTeamVersion = parsed.aiTeamVersion
    if (typeof parsed.orchestrationMode === 'boolean') summary.orchestrationMode = parsed.orchestrationMode
    if (typeof parsed.decisionGateClosed === 'boolean') summary.decisionGateClosed = parsed.decisionGateClosed
    if (typeof parsed.checkoutMode === 'string') summary.checkoutMode = parsed.checkoutMode
    if (typeof parsed.skipLinear === 'boolean') summary.skipLinear = parsed.skipLinear
    if (typeof parsed.updatedAt === 'string') summary.updatedAt = parsed.updatedAt
    return { active: summary }
  } catch {
    return { active: null, parseError: 'active-unparseable' }
  }
}

function buildWaves(rootAbs: string, activeKey: string | null): WaveEntry[] {
  const entries: WaveEntry[] = []
  const names = readdirSync(rootAbs)
    .filter((name) => name.startsWith('WAVE-') && name.endsWith('.md'))
    .sort()
  for (const name of names) {
    const key = basename(name, '.md')
    try {
      const filePath = resolveWithin(rootAbs, name)
      const raw = readFileSync(filePath, 'utf-8')
      const completedPath = resolveWithin(rootAbs, `${key}-completed.json`)
      const hasCompletedRecord = existsSync(completedPath)
      const status: WaveStatus = key === activeKey ? 'active' : hasCompletedRecord ? 'completed' : 'draft'
      entries.push({
        key,
        status,
        excerpt: excerpt(raw),
        mtime: statSync(filePath).mtimeMs,
        hasCompletedRecord,
      })
    } catch (err: any) {
      entries.push({ key, status: 'draft', parseError: err?.message || 'unreadable-entry' })
    }
  }
  return entries
}

/**
 * GET /api/ai-team/waves — wave markers + active distinction.
 * Metadata only (280-char excerpts, allowlisted active fields).
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const rootAbs = join(process.cwd(), WAVE_ROOT)
    if (!existsSync(rootAbs)) {
      return NextResponse.json(
        { waves: [], active: null, unavailable: true, message: `wave root not found: ${WAVE_ROOT}` },
        { headers: { 'Cache-Control': 'no-store' } }
      )
    }

    const { active, parseError } = readActiveSummary(rootAbs)
    const waves = buildWaves(rootAbs, active?.waveKey ?? null)
    const body: Record<string, unknown> = { waves, active }
    if (parseError) body.activeParseError = parseError

    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('AI team waves API error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
