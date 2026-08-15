import { describe, expect, it } from 'vitest'
import {
  getDeferredParkMaterialKey,
  latchDeferredParkCoverage,
  pruneDeferredParkCoverageLatch,
  type DeferredParkCoverageLatch
} from './terminal-activation-deferred-park-latch'

const POLICY = {
  sshParkingEnabled: true,
  pairedRuntimeParkingEnvironmentIds: new Set(['env-1'])
}

describe('deferred park coverage latch', () => {
  it('holds the first verdict across evaluator flips for the same material key', () => {
    const latch: DeferredParkCoverageLatch = new Map()
    const key = getDeferredParkMaterialKey({ ptyId: 'wt@@pty-1', generation: 0 }, POLICY)
    let covered = true
    const evaluate = (): boolean =>
      latchDeferredParkCoverage({
        latch,
        tabId: 'tab-a',
        materialKey: key,
        evaluateCoverage: () => covered
      })

    expect(evaluate()).toBe(true)
    // The lifecycle write-back the latch exists to ignore.
    covered = false
    expect(evaluate()).toBe(true)
    expect(evaluate()).toBe(true)
  })

  it('re-evaluates when material identity or restore policy changes', () => {
    const latch: DeferredParkCoverageLatch = new Map()
    const first = getDeferredParkMaterialKey({ ptyId: 'wt@@pty-1', generation: 0 }, POLICY)
    const remintedPty = getDeferredParkMaterialKey({ ptyId: 'wt@@pty-2', generation: 0 }, POLICY)
    const bumpedGeneration = getDeferredParkMaterialKey(
      { ptyId: 'wt@@pty-1', generation: 1 },
      POLICY
    )
    const sshDisabled = getDeferredParkMaterialKey(
      { ptyId: 'wt@@pty-1', generation: 0 },
      { ...POLICY, sshParkingEnabled: false }
    )
    const pairedChanged = getDeferredParkMaterialKey(
      { ptyId: 'wt@@pty-1', generation: 0 },
      { ...POLICY, pairedRuntimeParkingEnvironmentIds: new Set(['env-2']) }
    )
    expect(new Set([first, remintedPty, bumpedGeneration, sshDisabled, pairedChanged]).size).toBe(5)

    let verdict = true
    const evaluate = (materialKey: string): boolean =>
      latchDeferredParkCoverage({
        latch,
        tabId: 'tab-a',
        materialKey,
        evaluateCoverage: () => verdict
      })
    expect(evaluate(first)).toBe(true)
    verdict = false
    expect(evaluate(first)).toBe(true)
    expect(evaluate(remintedPty)).toBe(false)
  })

  it('ignores paired-runtime environment ordering', () => {
    const tab = { ptyId: 'wt@@pty-1', generation: 0 }
    const forward = getDeferredParkMaterialKey(tab, {
      sshParkingEnabled: true,
      pairedRuntimeParkingEnvironmentIds: new Set(['env-1', 'env-2'])
    })
    const reversed = getDeferredParkMaterialKey(tab, {
      sshParkingEnabled: true,
      pairedRuntimeParkingEnvironmentIds: new Set(['env-2', 'env-1'])
    })
    expect(forward).toBe(reversed)
  })

  it('prunes latches for revealed and closed tabs', () => {
    const latch: DeferredParkCoverageLatch = new Map([
      ['tab-a', { materialKey: 'a', covered: true }],
      ['tab-b', { materialKey: 'b', covered: false }],
      ['tab-c', { materialKey: 'c', covered: true }]
    ])
    // tab-a stays deferred; tab-b was revealed; tab-c was closed.
    pruneDeferredParkCoverageLatch(latch, new Set(['tab-a', 'tab-c']), new Set(['tab-a', 'tab-b']))
    expect(Array.from(latch.keys())).toEqual(['tab-a'])
    pruneDeferredParkCoverageLatch(latch, null, new Set(['tab-a']))
    expect(latch.size).toBe(0)
  })
})
