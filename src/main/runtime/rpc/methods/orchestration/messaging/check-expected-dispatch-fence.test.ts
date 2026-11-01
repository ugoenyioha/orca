import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

const PANE_A = 'tab_a:cccccccc-cccc-4ccc-8ccc-cccccccccccc'

type CheckResult = {
  deliveryId: string | null
  messages: { subject: string }[]
  count: number
}

/**
 * A caller that named the Dispatch it believes it still owns must be fenced the instant that
 * Dispatch settles, even though the pane/process checks above it in check-methods.ts still see a
 * live row for *some* active Dispatch (or none at all). Without this check a worker that already
 * completed D could race a re-attach/second-dispatch onto the same pane and read or ack the new
 * owner's mail under the belief it was still talking about D.
 */
describe('orchestration.check with expectedDispatchId', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext

  afterEach(() => {
    h.cleanup()
  })

  function setup(): { dispatchId: string } {
    ;({ db, ctx } = h.setup())
    const task = db.createTask({ spec: 'worker that may be completed under us' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker', PANE_A)
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'do the work',
      runId: dispatch.run_id
    })
    return { dispatchId: dispatch.id }
  }

  function check(params: Record<string, unknown>) {
    return h.call(
      'orchestration.check',
      { terminal: 'term_worker', terminalPaneKey: PANE_A, ...params },
      ctx
    ) as Promise<CheckResult>
  }

  function complete(dispatchId: string) {
    db.db.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?").run(dispatchId)
  }

  it('fences a peek whose named Dispatch completed under it, leaving mail unread and unacked', async () => {
    const { dispatchId } = setup()
    complete(dispatchId)

    await expect(check({ peek: true, expectedDispatchId: dispatchId })).rejects.toMatchObject({
      code: 'consumer_fenced'
    })
    expect(db.getUnreadMessages(`dispatch:${dispatchId}`)).toHaveLength(1)
  })

  it('fences a consuming check whose named Dispatch completed under it before any Delivery mints', async () => {
    const { dispatchId } = setup()
    await check({ peek: true, expectedDispatchId: dispatchId })
    complete(dispatchId)
    const direct = db.insertMessage({
      from: 'term_coord',
      to: 'term_worker',
      subject: 'must survive fallback race',
      runId: db.getDispatchContextById(dispatchId)!.run_id
    })
    const markRead = vi.spyOn(db, 'markAsRead')
    const acquire = vi.spyOn(db, 'getOrCreateMailboxDelivery')
    const ack = vi.spyOn(db, 'acknowledgeMailboxDelivery')
    try {
      await expect(check({ expectedDispatchId: dispatchId })).rejects.toMatchObject({
        code: 'consumer_fenced'
      })
      expect(db.getMessageById(direct.id)?.read).toBe(0)
      expect(db.getUnreadMessages(`dispatch:${dispatchId}`)).toHaveLength(1)
      expect(markRead).not.toHaveBeenCalled()
      expect(acquire).not.toHaveBeenCalled()
      expect(ack).not.toHaveBeenCalled()
    } finally {
      markRead.mockRestore()
      acquire.mockRestore()
      ack.mockRestore()
    }
  })

  it('fences an --ack whose named Dispatch completed under it, applying no acknowledgment', async () => {
    const { dispatchId } = setup()
    const first = await check({ expectedDispatchId: dispatchId })
    expect(first.deliveryId).not.toBeNull()
    complete(dispatchId)
    const before = db.getDeliveryRaw(first.deliveryId!)

    await expect(
      check({ ack: first.deliveryId, expectedDispatchId: dispatchId })
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    expect(db.getDeliveryRaw(first.deliveryId!)).toEqual(before)
    expect(db.getUnreadMessages(`dispatch:${dispatchId}`)).toHaveLength(1)
  })

  it('fences a caller naming a dispatch id that never matched its own active Dispatch', async () => {
    setup()
    const task2 = db.createTask({ spec: 'unrelated task' })
    const otherDispatch = createRootDispatch(db, task2.id, 'term_other', 'tab_other:x')

    await expect(check({ peek: true, expectedDispatchId: otherDispatch.id })).rejects.toMatchObject(
      { code: 'consumer_fenced' }
    )
  })

  it('does not fence a plain check with no expectedDispatchId against the same completed Dispatch', async () => {
    const { dispatchId } = setup()
    complete(dispatchId)

    // Why: existing callers that never adopted the new field keep today's behavior unchanged — a
    // completed Dispatch is not superseded, so this falls through to an empty direct mailbox read
    // rather than any fence. Proves the guard is opt-in, not a contract change for current callers.
    await expect(check({})).resolves.toMatchObject({ messages: [], count: 0 })
  })

  it('fences completion between identity resolution and worker revalidation', async () => {
    const { dispatchId } = setup()
    const direct = db.insertMessage({
      from: 'term_coord',
      to: 'term_worker',
      subject: 'survives race',
      runId: db.getDispatchContextById(dispatchId)!.run_id
    })
    const lookup = db.getActiveDispatchForIdentity.bind(db)
    let calls = 0
    const spy = vi
      .spyOn(db, 'getActiveDispatchForIdentity')
      .mockImplementation((handle, paneKey) => {
        if (++calls === 2) {
          complete(dispatchId)
        }
        return lookup(handle, paneKey)
      })
    try {
      await expect(check({ expectedDispatchId: dispatchId })).rejects.toMatchObject({
        code: 'dispatch_inactive'
      })
      expect(db.getMessageById(direct.id)?.read).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('rejects an explicit Run before acquiring a worker delivery', async () => {
    const { dispatchId } = setup()
    const run = db.getDispatchContextById(dispatchId)!.run_id
    await expect(check({ expectedDispatchId: dispatchId, run })).rejects.toMatchObject({
      code: 'consumer_fenced'
    })
    expect(db.getUnreadMessages(`dispatch:${dispatchId}`)).toHaveLength(1)
    expect(db.hasOutstandingMailboxDelivery(`dispatch:${dispatchId}`)).toBe(false)
  })

  it('passes through a matching expectedDispatchId on a live, unchanged Dispatch', async () => {
    const { dispatchId } = setup()

    const result = await check({ expectedDispatchId: dispatchId })
    expect(result.messages.map((message) => message.subject)).toEqual(['do the work'])
  })

  it.each([
    {}, { run: 'run_x', expectedDispatchId: 'ctx_x' }, { run: '' },
    { expectedDispatchId: ' ' }, { run: 'run_x', compatibilityAck: '{}' },
    { run: 'run_x', compatibilityQuestionAck: '{}' }
  ])('strict schema rejects unsafe addressing %j', async (params) => {
    setup()
    await expect(h.call('orchestration.checkDurable', {
      terminal: 'term_worker', terminalPaneKey: PANE_A, ...params
    }, ctx)).rejects.toBeDefined()
  })

  it('strict worker acknowledges only its acquired batch', async () => {
    const { dispatchId } = setup()
    const params = { terminal: 'term_worker', terminalPaneKey: PANE_A, expectedDispatchId: dispatchId }
    const first = await h.call('orchestration.checkDurable', params, ctx) as CheckResult
    expect(first.deliveryId).toBeTruthy()
    const later = db.insertMessage({ from: 'term_coord', to: `dispatch:${dispatchId}`,
      subject: 'later', runId: db.getDispatchContextById(dispatchId)!.run_id })
    await expect(h.call('orchestration.checkDurable', {
      ...params, ack: first.deliveryId, peek: true
    }, ctx)).resolves.toMatchObject({ acknowledged: first.deliveryId })
    expect(db.getUnreadMessages(`dispatch:${dispatchId}`).map((message) => message.id)).toEqual([later.id])
  })

  it('strict explicit Run returns a durable batch', async () => {
    const { dispatchId } = setup()
    const run = db.getDispatchContextById(dispatchId)!.run_id
    db.insertMessage({ from: 'term_worker', to: `run:${run}`, subject: 'run mail', runId: run })
    const result = await h.call('orchestration.checkDurable', { terminal: 'term_coord', run }, ctx) as CheckResult
    expect(result.deliveryId).toBeTruthy()
    expect(result.messages.map((message) => message.subject)).toContain('run mail')
    expect(result).not.toHaveProperty('legacyCompatibility')
  })
})
