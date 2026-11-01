import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CHECK_HANDLER } from './message-check-handler'
import { printResult } from '../../format'

vi.mock('../../format', () => ({ printResult: vi.fn() }))
vi.mock('./terminal-identity', () => ({
  resolveOrchestrationTerminalHandle: vi.fn(async () => 'term_worker'),
  orchestrationCallerLabel: vi.fn(() => 'term_worker')
}))

const capability = 'orchestration.check.manual-ack.expected-dispatch.v1'
const handler = ORCHESTRATION_CHECK_HANDLER['orchestration check']

describe('guarded check CLI', () => {
  beforeEach(() => vi.clearAllMocks())

  function invocation(reachable: boolean, capabilities?: string[]) {
    const client = {
      getCliStatus: vi.fn(async () => ({ result: { runtime: { reachable, capabilities } } })),
      call: vi.fn(async () => ({
        ok: true,
        result: {
          messages: [],
          count: 0,
          dispatchId: 'ctx_expected',
          legacyCompatibility: { ackMessageIds: ['msg_unpersisted'] }
        }
      }))
    }
    // SAFETY: this fixture implements the only client methods exercised by this handler.
    const args = {
      flags: new Map<string, string | boolean>([
        ['expected-dispatch', 'ctx_expected'],
        ['terminal', 'term_worker']
      ]),
      client,
      cwd: '/tmp',
      json: true
    } as unknown as Parameters<typeof handler>[0]
    return { client, args }
  }

  it.each([
    { reachable: true, capabilities: undefined },
    { reachable: true, capabilities: [] },
    { reachable: false, capabilities: [capability] }
  ])('refuses unsupported target before check: %j', async (status) => {
    const { client, args } = invocation(status.reachable, status.capabilities)
    await expect(handler(args)).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(client.call).not.toHaveBeenCalled()
    expect(printResult).not.toHaveBeenCalled()
  })

  it('refuses compatibility auto-ACK despite advertised capability', async () => {
    const { client, args } = invocation(true, [capability])
    await expect(handler(args)).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(client.call).toHaveBeenCalledTimes(1)
    expect(client.call).toHaveBeenCalledWith(
      'orchestration.checkDurable',
      expect.objectContaining({
        terminal: 'term_worker',
        expectedDispatchId: 'ctx_expected'
      })
    )
    expect(printResult).not.toHaveBeenCalled()
  })
})
