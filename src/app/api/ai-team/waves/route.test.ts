import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requireRole } from '@/lib/auth'
import { GET } from './route'

vi.mock('@/lib/auth', () => ({
  requireRole: vi.fn(),
}))

const mockedRequireRole = vi.mocked(requireRole)

describe('GET /api/ai-team/waves', () => {
  const realCwd = process.cwd()
  let cwdSpy: any

  beforeEach(() => {
    mockedRequireRole.mockReturnValue({ user: { role: 'viewer' } } as any)
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(realCwd)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns markers with active distinction and no-store', async () => {
    const res = await GET({} as any)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = await res.json()
    expect(Array.isArray(body.waves)).toBe(true)
    expect(body.waves.length).toBeGreaterThan(0)
    for (const wave of body.waves) {
      expect(['active', 'completed', 'draft']).toContain(wave.status)
      expect(typeof wave.key).toBe('string')
      if (wave.excerpt) expect(wave.excerpt.length).toBeLessThanOrEqual(280)
      expect(wave.parseError === undefined || typeof wave.parseError === 'string').toBe(true)
    }
    expect(body.active?.waveKey).toBe('WAVE-20261019-0738')
    const activeEntry = body.waves.find((w: any) => w.key === 'WAVE-20261019-0738')
    expect(activeEntry?.status).toBe('active')
    const completed = body.waves.find((w: any) => w.key === 'WAVE-20261018-1103')
    expect(completed?.status).toBe('completed')
    expect(completed?.hasCompletedRecord).toBe(true)
  })

  it('active summary is allowlisted metadata only', async () => {
    const res = await GET({} as any)
    const body = await res.json()
    const allowed = [
      'waveKey',
      'waveId',
      'aiTeam',
      'aiTeamVersion',
      'orchestrationMode',
      'decisionGateClosed',
      'checkoutMode',
      'skipLinear',
      'updatedAt',
    ]
    for (const key of Object.keys(body.active ?? {})) {
      expect(allowed).toContain(key)
    }
  })

  it('ignores traversal-style query params safely', async () => {
    const res = await GET({ url: 'http://localhost/api/ai-team/waves?path=..%2F..%2Fpackage.json' } as any)
    expect(res.status).toBe(200)
    const text = JSON.stringify(await res.json())
    expect(text).not.toContain('mission-control-monorepo')
  })

  it('passes through auth failures (401)', async () => {
    mockedRequireRole.mockReturnValue({ error: 'Authentication required', status: 401 } as any)
    const res = await GET({} as any)
    expect(res.status).toBe(401)
  })

  it('returns 200 unavailable:true when the wave root is missing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ai-team-nowave-'))
    cwdSpy.mockReturnValue(empty)
    const res = await GET({} as any)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = await res.json()
    expect(body.unavailable).toBe(true)
    expect(body.waves).toEqual([])
    expect(body.active).toBeNull()
  })

  it('marks unparseable entries without 500', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-team-badwave-'))
    mkdirSync(join(dir, 'state', 'wave'), { recursive: true })
    writeFileSync(join(dir, 'state', 'wave', 'active.json'), '{not json')
    mkdirSync(join(dir, 'state', 'wave', 'WAVE-20990101-0000.md'), { recursive: true })
    cwdSpy.mockReturnValue(dir)
    const res = await GET({} as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.active).toBeNull()
    expect(body.activeParseError).toBe('active-unparseable')
    // a directory where a marker file is expected → per-entry parseError, still 200
    expect(body.waves).toHaveLength(1)
    expect(body.waves[0].parseError).toBeTruthy()
  })

  it('response carries no secret material', async () => {
    const res = await GET({} as any)
    const text = JSON.stringify(await res.json())
    expect(text).not.toMatch(/OPENCLAW_HOME/)
    expect(text).not.toMatch(/node_modules/)
    if (process.env.API_KEY) expect(text).not.toContain(process.env.API_KEY)
  })
})
