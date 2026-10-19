/**
 * DEMO TOUR — human click-through checklist (~5 min, same 7 legs as below).
 *
 * Pre-reqs: `docker compose up -d` green on this host; you know the seed ADMIN
 * username/password (repo .env AUTH_USER/AUTH_PASS — never commit them).
 * Base URL for compose: http://127.0.0.1:3000 (replace host if remote).
 *
 *  1. BRIDGE LIVE (~30s): open the dashboard → header/nav gateway dot is green
 *     ("Gateway connected"). Proof the containerized bridge WS handshake works.
 *  2. ROSTER PRESENT (~30s): open the Agents tab → wave role rows are listed
 *     (historian, workspace-expert, implementer, qa, curator, orchestrator…).
 *  3. SPAWN LOCAL (~1 min): Spawn panel → task "demo tour probe", any model,
 *     label `demo-tour-<anything>` → success toast; new row appears in Agents.
 *  4. MESSAGE LOCAL (~30s): open that agent → send it a direct message →
 *     200 ack toast. (MC-side acceptance only — downstream gateway delivery is
 *     best-effort by design and NOT asserted.)
 *  5. WAKE LOCAL (~30s): hit Wake on the same agent → status flips to idle /
 *     "Manual wake" activity. 200 ack.
 *  6. TASKS E2E (~1 min): Tasks tab → create `[demo-tour] <title>` → move to
 *     In Progress → approve (Aegis quality review) → move to Done. Leave the
 *     closed row in place (no deletes on tour).
 *  7. QUIET FEED (~30s): open the Live Feed rail during legs 3–6 → agent.* /
 *     task.* events stream in, zero error-level entries, no reconnect spam.
 *
 * Pass bar: all 7 legs PASS, and at no point does the browser touch LSports
 * (no lsports, di-prefixed, sportradar, betgenius, or bet365 traffic;
 * reconnect / gateway-fetch console errors).
 *
 * RUN (exact — against the compose stack, headless):
 *   E2E_BASE_URL=http://127.0.0.1:3000 \
 *   E2E_ADMIN_USER='<repo .env AUTH_USER>' E2E_ADMIN_PASS='<repo .env AUTH_PASS>' \
 *   npx playwright test --config /tmp/demo-tour.playwright.config.cjs --project=chromium
 * (creds read from the environment at runtime — never hardcoded, never committed;
 * the spec itself falls back to parsing repo .env AUTH_USER/AUTH_PASS.)
 * The /tmp config override pins testDir/testMatch/baseURL and defines NO
 * webServer: the repo playwright.config.ts targets :3005 with a `pnpm start`
 * webServer block, which would boot a SECOND (host) Mission Control that
 * shadows the compose stack and invalidates every assertion below.
 * Do NOT edit playwright.config.ts for this tour — use the override.
 * Pre-flight: host :3000 must reach the compose container (no stale host
 * `next-server` squatting localhost:3000 — it serves the repo .data DB,
 * not the compose mc-data volume, and silently invalidates the tour).
 */

import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { FALLBACK_ROLES } from '../bridge/roster'

// Live-stack gate: plain `playwright test` (CI) has neither a stack nor creds.
// Run the tour explicitly: E2E_LIVE=1 E2E_BASE_URL=http://127.0.0.1:3000
//   E2E_ADMIN_USER=... E2E_ADMIN_PASS=... npx playwright test demo-tour
test.skip(
  process.env.E2E_LIVE !== '1',
  'demo tour needs a live compose stack (set E2E_LIVE=1)',
)

// ---------------------------------------------------------------------------
// Tour setup: compose stack, seed ADMIN creds, hosts
// ---------------------------------------------------------------------------

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000'
const BRIDGE_URL =
  process.env.E2E_BRIDGE_URL || BASE_URL.replace(/:\d+$/, '') + ':3101'

/** Seed ADMIN creds: env first, repo .env fallback. Values never hardcoded. */
function getAdminCreds(): { username: string; password: string } {
  const fromEnv = {
    username: process.env.E2E_ADMIN_USER || '',
    password: process.env.E2E_ADMIN_PASS || '',
  }
  if (fromEnv.username && fromEnv.password) return fromEnv
  const envPath = path.resolve(__dirname, '..', '.env')
  const raw = fs.readFileSync(envPath, 'utf-8')
  const pick = (key: string): string => {
    const m = raw.match(new RegExp(`^${key}=(.*)$`, 'm'))
    return (m?.[1] || '').trim().replace(/^["']|["']$/g, '')
  }
  const username = pick('AUTH_USER')
  const password = pick('AUTH_PASS')
  expect(
    username && password,
    'admin creds: set E2E_ADMIN_USER/E2E_ADMIN_PASS or repo .env AUTH_USER/AUTH_PASS',
  ).toBeTruthy()
  return { username, password }
}

// One label per run; deliberately outside the `local-*` session namespace so
// the bridge roster-sync loop ignores it.
const EPOCH = Date.now()
const TOUR_LABEL = `demo-tour-${EPOCH}`
const TOUR_TASK_TITLE = `[demo-tour] tour task ${EPOCH}`

// ---------------------------------------------------------------------------
// No-LSports + quiet-console guards
// ---------------------------------------------------------------------------

const FORBIDDEN_URL = /(lsports|di-|sportradar|betgenius|bet365)/i
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', 'mission-control'])
const NOISY_CONSOLE = /reconnect|ECONNREFUSED|Failed to fetch.*gateway/i

function checkUrl(u: string): string | null {
  let host = ''
  try {
    host = new URL(u, BASE_URL).hostname
  } catch {
    return `unparseable URL: ${u}`
  }
  if (FORBIDDEN_URL.test(u)) return `forbidden vendor URL: ${u}`
  if (host && !ALLOWED_HOSTS.has(host)) return `off-host URL: ${u}`
  return null
}

interface PageGuards {
  violations: string[]
  assertClean: () => void
}

function attachPageGuards(page: Page): PageGuards {
  const violations: string[] = []
  page.on('request', (req) => {
    const v = checkUrl(req.url())
    if (v) violations.push(v)
  })
  page.on('pageerror', (err) => {
    violations.push(`pageerror: ${err?.message || err}`)
  })
  page.on('console', (msg) => {
    if (msg.type() === 'error' && NOISY_CONSOLE.test(msg.text())) {
      violations.push(`console.error: ${msg.text().slice(0, 200)}`)
    }
  })
  return {
    violations,
    assertClean: () => expect(violations, 'quiet-feed violations').toEqual([]),
  }
}

/** API login → session cookie, logged in once per file and reused. */
let cachedCookie: string | null = null

async function loginCookie(request: APIRequestContext): Promise<string> {
  if (cachedCookie) return cachedCookie
  const { username, password } = getAdminCreds()
  // Quiet retry on 429 (login rate limiter): back off and retry, no spam.
  let lastStatus = 0
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = await request.post(`${BASE_URL}/api/auth/login`, {
      data: { username, password },
    })
    lastStatus = res.status()
    if (lastStatus === 200) {
      const setCookie = res.headers()['set-cookie'] || ''
      const m = setCookie.match(/mc-session=([^;]+)/)
      expect(m, 'mc-session cookie set').toBeTruthy()
      cachedCookie = `mc-session=${m![1]}`
      return cachedCookie
    }
    if (lastStatus !== 429) break
    const retryAfter = Number(res.headers()['retry-after'] || '2') * 1000
    await new Promise((r) => setTimeout(r, Math.min(retryAfter, 10_000)))
  }
  expect(lastStatus, 'seed ADMIN login (after 429 retries)').toBe(200)
  throw new Error('unreachable')
}

// ---------------------------------------------------------------------------
// Leg 7 SSE capture (started in leg 3 so it spans legs 3–6)
// ---------------------------------------------------------------------------

interface SseCapture {
  events: Array<{ type: string; raw: string }>
  chunks: number
  stop: () => void
  done: Promise<void>
  startedAt: number
}

function startSseCapture(cookie: string): SseCapture {
  const events: Array<{ type: string; raw: string }> = []
  const cap: SseCapture = {
    events,
    chunks: 0,
    stop: () => {},
    done: Promise.resolve(),
    startedAt: Date.now(),
  }
  const ctrl = new AbortController()
  cap.stop = () => ctrl.abort()
  cap.done = (async () => {
    const res = await fetch(`${BASE_URL}/api/events`, {
      headers: { cookie },
      signal: ctrl.signal,
    })
    expect(res.status, 'SSE /api/events status').toBe(200)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        cap.chunks += 1
        buf += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            try {
              const evt = JSON.parse(payload)
              if (typeof evt?.type === 'string') {
                const v = checkUrl(JSON.stringify(evt).slice(0, 2000))
                if (v) events.push({ type: '__url-violation__', raw: v })
                else events.push({ type: evt.type, raw: payload.slice(0, 500) })
              }
            } catch {
              /* non-JSON frame — ignore */
            }
          }
        }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') throw e
    } finally {
      reader.releaseLock()
    }
  })()
  return cap
}

// ---------------------------------------------------------------------------
// The tour: 7 ordered legs, serial
// ---------------------------------------------------------------------------

test.describe.serial('demo tour (compose, zero-LSports proof)', () => {
  let guards: PageGuards | null = null
  let sse: SseCapture | null = null
  let spawnedAgentId: number | null = null
  let tourTaskId: number | null = null

  test('leg 1 — bridge live (health + dashboard gateway Connected)', async ({
    page,
    request,
  }) => {
    await test.step('bridge /health is ok', async () => {
      const res = await request.get(`${BRIDGE_URL}/health`)
      expect(res.status()).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.waveKey).toBeTruthy()
    })

    await test.step('seed ADMIN login via dashboard UI', async () => {
      guards = attachPageGuards(page)
      const { username, password } = getAdminCreds()
      await page.goto(`${BASE_URL}/login`)
      await expect(page).toHaveURL(/\/login/)
      // Quiet retry: the login limiter allows 5 attempts/min per IP, and
      // earlier tour legs share that budget — back off and retry, no spam.
      let loggedIn = false
      for (let attempt = 0; attempt < 12 && !loggedIn; attempt++) {
        await page.locator('#username').fill(username)
        await page.locator('#password').fill(password)
        await page.getByRole('button', { name: 'Sign in' }).click()
        try {
          await expect(page).toHaveURL(`${BASE_URL}/`, { timeout: 10_000 })
          loggedIn = true
        } catch {
          await page.waitForTimeout(8_000)
        }
      }
      expect(loggedIn, 'dashboard UI login').toBe(true)
    })

    await test.step('gateway dot shows Connected (bridge WS handshake)', async () => {
      // Nav rail exposes the WS state as title + text; bridge speaks the
      // gateway challenge protocol, so the dot must settle green.
      await expect(page.getByTitle('Gateway connected').first()).toBeVisible({
        timeout: 30_000,
      })
      await expect(
        page.getByRole('button', { name: 'Gateway Online' }),
      ).toBeVisible()
    })

    guards!.assertClean()
    console.log('LEG 1 PASS — bridge live, dashboard gateway Connected')
  })

  test('leg 2 — roster present (exact: 7 canonical roles, enum statuses)', async ({
    request,
  }) => {
    const cookie = await loginCookie(request)
    const res = await request.get(`${BASE_URL}/api/agents?limit=200`, {
      headers: { cookie },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    const agents: any[] = body.agents || []
    expect(Array.isArray(agents), 'agents array').toBe(true)
    // Roster-managed rows only: the bridge-roster-sync ownership tag.
    // (Tour spawn rows carry `local-spawn-*` keys and no tag — excluded.)
    const managed = agents.filter(
      (a) => (a.config as any)?.managedBy === 'bridge-roster-sync',
    )
    const keys = managed.map((a) => String(a.session_key || ''))
    // Baseline: COUNT(*) = COUNT(DISTINCT session_key) = 7 on the roster set.
    expect(managed.length, 'managed roster row count').toBe(FALLBACK_ROLES.length)
    expect(new Set(keys).size, 'distinct roster session_keys').toBe(
      FALLBACK_ROLES.length,
    )
    // Exact role-name coverage: the canonical fallback set, no more, no less.
    // (This is the assertion that catches partial-discovery degradation.)
    expect(
      managed.map((a) => a.name).sort(),
      'canonical role names',
    ).toEqual([...FALLBACK_ROLES].sort())
    // Enum-only statuses (matches createAgentSchema in src/lib/validation.ts).
    const MC_STATUS_ENUM = new Set(['online', 'offline', 'busy', 'idle', 'error'])
    for (const row of managed) {
      expect(MC_STATUS_ENUM.has(row.status), `status enum (${row.name})`).toBe(true)
    }
    console.log(
      `LEG 2 PASS — roster exact 7/7 (${managed.map((a) => `${a.name}=${a.status}`).join(', ')})`,
    )
  })

  test('leg 3 — spawn local agent row (starts SSE capture)', async ({ request }) => {
    const cookie = await loginCookie(request)
    sse = startSseCapture(cookie)
    // Let the SSE stream deliver its `connected` frame before we mutate.
    await page_wait(1500)

    const res = await request.post(`${BASE_URL}/api/spawn`, {
      headers: { cookie },
      data: {
        task: 'demo tour capability probe — verify local spawn path',
        model: 'local',
        label: TOUR_LABEL,
      },
    })
    expect(res.status(), 'spawn ack').toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.agent?.name).toBe(TOUR_LABEL)

    const list = await request.get(`${BASE_URL}/api/agents?limit=200`, {
      headers: { cookie },
    })
    expect(list.status()).toBe(200)
    const agents: any[] = (await list.json()).agents || []
    const row = agents.find((a) => a.name === TOUR_LABEL)
    expect(row, `spawned row ${TOUR_LABEL} listed`).toBeTruthy()
    spawnedAgentId = row.id
    console.log(
      `LEG 3 PASS — spawned ${TOUR_LABEL} (id ${spawnedAgentId}, delivery=${body.delivery})`,
    )
  })

  test('leg 4 — message local (MC-side 200 ack, not gateway delivery)', async ({
    request,
  }) => {
    const cookie = await loginCookie(request)
    const res = await request.post(`${BASE_URL}/api/agents/message`, {
      headers: { cookie },
      data: {
        to: TOUR_LABEL,
        from: 'demo-tour',
        message: 'demo-tour ping — confirm MC-side acceptance',
      },
    })
    // MC-side acceptance only: 200 ack proves the thread is stored + notified.
    // `delivery` is best-effort by design and is recorded, never asserted.
    expect(res.status(), 'message ack').toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    console.log(`LEG 4 PASS — message acked (delivery=${body.delivery}, unasserted)`)
  })

  test('leg 5 — wake local agent', async ({ request }) => {
    const cookie = await loginCookie(request)
    expect(spawnedAgentId, 'spawned agent id from leg 3').toBeTruthy()
    const res = await request.post(
      `${BASE_URL}/api/agents/${spawnedAgentId}/wake`,
      {
        headers: { cookie },
        data: { message: 'demo-tour wake check-in' },
      },
    )
    expect(res.status(), 'wake ack').toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    // Cheap row check: wake records status idle + Manual wake activity.
    const row = await request.get(`${BASE_URL}/api/agents/${spawnedAgentId}`, {
      headers: { cookie },
    })
    expect(row.status(), 'wake row readable').toBe(200)
    expect((await row.json()).agent?.status, 'wake sets idle').toBe('idle')
    console.log(`LEG 5 PASS — wake acked (delivery=${body.delivery}, row idle)`)
  })

  test('leg 6 — tasks e2e (create → in_progress → aegis-approved done, row kept)', async ({
    request,
  }) => {
    const cookie = await loginCookie(request)

    const created = await request.post(`${BASE_URL}/api/tasks`, {
      headers: { cookie },
      data: {
        title: TOUR_TASK_TITLE,
        description: 'demo-tour lifecycle probe; closed row intentionally kept',
      },
    })
    expect(created.status(), 'task create').toBeLessThan(300)
    const createdBody = await created.json()
    tourTaskId = createdBody.task?.id ?? createdBody.id
    expect(tourTaskId, 'task id').toBeTruthy()

    const toProgress = await request.put(`${BASE_URL}/api/tasks/${tourTaskId}`, {
      headers: { cookie },
      data: { status: 'in_progress' },
    })
    expect(toProgress.status(), 'task → in_progress').toBe(200)

    // The app gates `done` on an Aegis quality approval — grant it inline,
    // exactly as an operator would, then close the task.
    const approval = await request.post(`${BASE_URL}/api/quality-review`, {
      headers: { cookie },
      data: {
        taskId: tourTaskId,
        reviewer: 'aegis',
        status: 'approved',
        notes: 'demo-tour self-approval for lifecycle probe',
      },
    })
    expect(approval.status(), 'aegis approval').toBe(200)

    const toDone = await request.put(`${BASE_URL}/api/tasks/${tourTaskId}`, {
      headers: { cookie },
      data: { status: 'done' },
    })
    expect(toDone.status(), 'task → done').toBe(200)

    const fetched = await request.get(`${BASE_URL}/api/tasks/${tourTaskId}`, {
      headers: { cookie },
    })
    expect(fetched.status()).toBe(200)
    expect((await fetched.json()).task?.status).toBe('done')
    // No DELETE: the closed [demo-tour] row stays as tour evidence.
    console.log(`LEG 6 PASS — task ${tourTaskId} [demo-tour] inbox → in_progress → done`)
  })

  test('leg 7 — quiet feed (SSE spans legs 3–6: domain events, zero errors)', async () => {
    expect(sse, 'SSE capture started in leg 3').toBeTruthy()
    // Guarantee a ~15s observation window spanning legs 3–6.
    const elapsed = Date.now() - sse!.startedAt
    if (elapsed < 15_000) await page_wait(15_000 - elapsed)
    sse!.stop()
    await sse!.done

    const events = sse!.events
    expect(sse!.chunks, 'SSE stream delivered chunks').toBeGreaterThan(0)
    expect(events.length, 'SSE delivered events').toBeGreaterThan(0)
    const domain = events.filter(
      (e) => e.type.startsWith('task.') || e.type.startsWith('agent.'),
    )
    expect(domain.length, 'agent.*/task.* events present').toBeGreaterThan(0)
    const errors = events.filter(
      (e) => e.type.includes('error') || e.type === '__url-violation__',
    )
    expect(errors, 'zero error-level / vendor entries').toEqual([])
    const types = [...new Set(events.map((e) => e.type))].sort().join(', ')
    console.log(`LEG 7 PASS — quiet feed (${events.length} events: ${types})`)
  })
})

function page_wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
