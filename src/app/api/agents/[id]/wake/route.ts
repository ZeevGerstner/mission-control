import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers } from '@/lib/db'
import { runOpenClaw } from '@/lib/command'
import { requireRole } from '@/lib/auth'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const resolvedParams = await params
    const agentId = resolvedParams.id
    const body = await request.json().catch(() => ({}))
    const customMessage =
      typeof body?.message === 'string' ? body.message.trim() : ''

    const db = getDatabase()
    const agent: any = isNaN(Number(agentId))
      ? db.prepare('SELECT * FROM agents WHERE name = ?').get(agentId)
      : db.prepare('SELECT * FROM agents WHERE id = ?').get(Number(agentId))

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    const message =
      customMessage ||
      `Wake up check-in for ${agent.name}. Please review assigned tasks and notifications.`

    // Local-first: the wake is recorded regardless of gateway reachability.
    db_helpers.updateAgentStatus(agent.name, 'idle', 'Manual wake')

    // Gateway delivery is best-effort.
    let delivery: 'gateway' | 'local' = 'local'
    if (agent.session_key) {
      try {
        const { stdout, stderr } = await runOpenClaw(
          ['gateway', 'sessions_send', '--session', agent.session_key, '--message', message],
          { timeoutMs: 10000 }
        )

        if (stderr && stderr.includes('error')) {
          console.warn('Gateway wake reported an error, kept local:', stderr.trim())
        } else {
          delivery = 'gateway'
        }
      } catch (err) {
        console.warn('Gateway wake unavailable, kept local:', (err as Error)?.message)
      }
    }

    return NextResponse.json({
      success: true,
      delivery,
      session_key: agent.session_key
    })
  } catch (error) {
    console.error('POST /api/agents/[id]/wake error:', error)
    return NextResponse.json({ error: 'Failed to wake agent' }, { status: 500 })
  }
}
