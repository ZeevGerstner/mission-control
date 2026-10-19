import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requireRole } from '@/lib/auth'
import { GET, CATALOG_SECTIONS } from './route'

vi.mock('@/lib/auth', () => ({
  requireRole: vi.fn(),
}))

const mockedRequireRole = vi.mocked(requireRole)

function req(url: string): any {
  return { url }
}

function authed() {
  mockedRequireRole.mockReturnValue({ user: { role: 'viewer' } } as any)
}

describe('GET /api/ai-team/catalog', () => {
  const realCwd = process.cwd()
  let cwdSpy: any

  beforeEach(() => {
    authed()
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(realCwd)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns all three sections when ?section= is omitted', async () => {
    const res = await GET(req('http://localhost/api/ai-team/catalog'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['commands', 'roster', 'workspaces'])
    expect(body.workspaces.entries).toEqual([
      { id: 'mission-control', title: 'mission-control', excerpt: 'Local workspace (repo root)' },
    ])
    expect(body.roster.entries.length).toBeGreaterThan(0)
    expect(body.commands.entries.length).toBeGreaterThan(0)
  })

  it('roster entries are metadata-only (280-char cap, frontmatter fields)', async () => {
    const res = await GET(req('http://localhost/api/ai-team/catalog?section=roster'))
    const body = await res.json()
    expect(body.section).toBe('roster')
    for (const entry of body.entries) {
      expect(typeof entry.id).toBe('string')
      if (entry.description) expect(entry.description.length).toBeLessThanOrEqual(280)
      // never raw bodies: no entry may carry a full agent prompt
      expect(JSON.stringify(entry).length).toBeLessThan(2000)
      expect(entry.parseError === undefined || typeof entry.parseError === 'string').toBe(true)
    }
    const ids = body.entries.map((e: any) => e.id)
    expect(ids).toContain('qa-engineer')
    expect(ids).toContain('orchestrator')
  })

  it('commands entries carry title + excerpt, never raw bodies', async () => {
    const res = await GET(req('http://localhost/api/ai-team/catalog?section=commands'))
    const body = await res.json()
    for (const entry of body.entries) {
      if (entry.excerpt) expect(entry.excerpt.length).toBeLessThanOrEqual(280)
    }
    const ids = body.entries.map((e: any) => e.id)
    expect(ids).toContain('new-wave')
  })

  it('rejects unknown ?section= with 400', async () => {
    for (const bad of ['bogus', '../..', '..%2F..%2Fetc', 'roster,commands', '']) {
      if (bad === '') continue
      const res = await GET(req(`http://localhost/api/ai-team/catalog?section=${bad}`))
      expect(res.status).toBe(400)
      expect(await res.json()).toHaveProperty('error')
    }
  })

  it('traversal-style section values never leak files', async () => {
    const res = await GET(req('http://localhost/api/ai-team/catalog?section=..%2F..%2Fpackage.json'))
    expect(res.status).toBe(400)
  })

  it('passes through auth failures (401)', async () => {
    mockedRequireRole.mockReturnValue({ error: 'Authentication required', status: 401 } as any)
    const res = await GET(req('http://localhost/api/ai-team/catalog'))
    expect(res.status).toBe(401)
  })

  it('returns 200 unavailable:true when roots are missing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ai-team-empty-'))
    cwdSpy.mockReturnValue(empty)
    const res = await GET(req('http://localhost/api/ai-team/catalog'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.roster.unavailable).toBe(true)
    expect(body.commands.unavailable).toBe(true)
    expect(body.workspaces.entries).toHaveLength(1)
  })

  it('marks malformed agent files with parseError, never 500', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-team-bad-'))
    mkdirSync(join(dir, '.cursor', 'agents'), { recursive: true })
    mkdirSync(join(dir, '.cursor', 'commands'), { recursive: true })
    writeFileSync(join(dir, '.cursor', 'agents', 'broken.md'), 'no frontmatter here\njust text')
    writeFileSync(join(dir, '.cursor', 'agents', 'ok.md'), '---\nname: ok\ndescription: Fine agent.\n---\nBody here.')
    cwdSpy.mockReturnValue(dir)
    const res = await GET(req('http://localhost/api/ai-team/catalog?section=roster'))
    expect(res.status).toBe(200)
    const body = await res.json()
    const broken = body.entries.find((e: any) => e.id === 'broken')
    const ok = body.entries.find((e: any) => e.id === 'ok')
    expect(broken.parseError).toBeTruthy()
    expect(ok.description).toBe('Fine agent.')
  })

  it('response carries no secret material', async () => {
    const res = await GET(req('http://localhost/api/ai-team/catalog'))
    const text = JSON.stringify(await res.json())
    expect(text).not.toMatch(/OPENCLAW_HOME/)
    expect(text).not.toMatch(/\.env/)
    expect(text).not.toMatch(/node_modules/)
    if (process.env.API_KEY) expect(text).not.toContain(process.env.API_KEY)
  })

  it('exposes the section allowlist', () => {
    expect([...CATALOG_SECTIONS].sort()).toEqual(['commands', 'roster', 'workspaces'])
  })
})
