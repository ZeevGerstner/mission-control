import { NextRequest, NextResponse } from 'next/server'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { requireRole } from '@/lib/auth'
import { resolveWithin } from '@/lib/paths'

const AGENTS_ROOT = '.cursor/agents'
const COMMANDS_ROOT = '.cursor/commands'
const EXCERPT_LEN = 280

export const CATALOG_SECTIONS = ['workspaces', 'roster', 'commands'] as const
export type CatalogSection = (typeof CATALOG_SECTIONS)[number]

export interface CatalogEntry {
  id: string
  title?: string
  description?: string
  excerpt?: string
  role?: string
  model?: string
  parseError?: string
}

export interface SectionPayload {
  entries: CatalogEntry[]
  unavailable?: true
  message?: string
}

function isCatalogSection(value: string | null): value is CatalogSection {
  return value !== null && (CATALOG_SECTIONS as readonly string[]).includes(value)
}

/** Collapse whitespace and cap length — metadata only, never raw bodies. */
export function excerpt(text: string, len = EXCERPT_LEN): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > len ? flat.slice(0, len) : flat
}

/** Minimal `key: value` frontmatter parser. Throws on missing/invalid block. */
export function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  if (!raw.startsWith('---')) throw new Error('missing-frontmatter')
  const close = raw.indexOf('\n---', 3)
  if (close === -1) throw new Error('unterminated-frontmatter')
  const block = raw.slice(3, close)
  const data: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const colon = trimmed.indexOf(':')
    if (colon === -1) continue
    const key = trimmed.slice(0, colon).trim()
    let value = trimmed.slice(colon + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) data[key] = value
  }
  return { data, body: raw.slice(close + 4) }
}

function readMarkdownDir(rootAbs: string): string[] {
  return readdirSync(rootAbs)
    .filter((name) => name.endsWith('.md'))
    .sort()
}

function buildRoster(rootAbs: string): SectionPayload {
  if (!existsSync(rootAbs)) {
    return { entries: [], unavailable: true, message: `agent root not found: ${AGENTS_ROOT}` }
  }
  const entries: CatalogEntry[] = []
  for (const name of readMarkdownDir(rootAbs)) {
    const id = basename(name, '.md')
    try {
      const filePath = resolveWithin(rootAbs, name)
      const raw = readFileSync(filePath, 'utf-8')
      const { data } = parseFrontmatter(raw)
      entries.push({
        id,
        title: data.name || id,
        description: excerpt(data.description || ''),
        role: data.role,
        model: data.model,
      })
    } catch (err: any) {
      entries.push({ id, parseError: err?.message || 'unreadable-entry' })
    }
  }
  return { entries }
}

function buildCommands(rootAbs: string): SectionPayload {
  if (!existsSync(rootAbs)) {
    return { entries: [], unavailable: true, message: `command root not found: ${COMMANDS_ROOT}` }
  }
  const entries: CatalogEntry[] = []
  for (const name of readMarkdownDir(rootAbs)) {
    const id = basename(name, '.md')
    try {
      const filePath = resolveWithin(rootAbs, name)
      const raw = readFileSync(filePath, 'utf-8')
      const heading = raw.split('\n').find((line) => line.startsWith('# '))
      const body = raw.replace(/^---[\s\S]*?---\n/, '')
      entries.push({ id, title: heading ? heading.replace(/^#\s+/, '').trim() : id, excerpt: excerpt(body) })
    } catch (err: any) {
      entries.push({ id, parseError: err?.message || 'unreadable-entry' })
    }
  }
  return { entries }
}

function buildWorkspaces(): SectionPayload {
  return { entries: [{ id: 'mission-control', title: 'mission-control', excerpt: 'Local workspace (repo root)' }] }
}

const BUILDERS: Record<CatalogSection, (root: string) => SectionPayload> = {
  workspaces: () => buildWorkspaces(),
  roster: (root) => buildRoster(join(root, AGENTS_ROOT)),
  commands: (root) => buildCommands(join(root, COMMANDS_ROOT)),
}

/**
 * GET /api/ai-team/catalog[?section=workspaces|roster|commands]
 * Read-only metadata catalog. Unknown ?section= → 400.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const { searchParams } = new URL(request.url)
    const sectionParam = searchParams.get('section')
    const root = process.cwd()

    if (sectionParam !== null && !isCatalogSection(sectionParam)) {
      return NextResponse.json(
        { error: `Unknown section '${sectionParam}'. Allowed: ${CATALOG_SECTIONS.join(', ')}` },
        { status: 400 }
      )
    }

    if (sectionParam) {
      return NextResponse.json({ section: sectionParam, ...BUILDERS[sectionParam](root) })
    }

    return NextResponse.json({
      workspaces: buildWorkspaces(),
      roster: buildRoster(join(root, AGENTS_ROOT)),
      commands: buildCommands(join(root, COMMANDS_ROOT)),
    })
  } catch (error) {
    console.error('AI team catalog API error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
