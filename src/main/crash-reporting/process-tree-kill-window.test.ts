import { beforeEach, describe, expect, it } from 'vitest'
import {
  countSiblingProcessTreeKills,
  observeProcessGoneKill,
  PROCESS_TREE_KILL_WINDOW_MS,
  resetProcessTreeKillWindowForTest
} from './process-tree-kill-window'

const childKill = (at: number, exitCode = 1) =>
  ({ at, source: 'child', reason: 'killed', exitCode }) as const

beforeEach(() => {
  resetProcessTreeKillWindowForTest()
})

describe('countSiblingProcessTreeKills', () => {
  it('counts child kills with the same reason and exit code inside the window', () => {
    observeProcessGoneKill(childKill(1_000))
    observeProcessGoneKill(childKill(1_100))

    expect(countSiblingProcessTreeKills({ reason: 'killed', exitCode: 1, at: 1_150 })).toBe(2)
  })

  it('ignores kills outside the correlation window in either direction', () => {
    observeProcessGoneKill(childKill(1_000))

    expect(
      countSiblingProcessTreeKills({
        reason: 'killed',
        exitCode: 1,
        at: 1_000 + PROCESS_TREE_KILL_WINDOW_MS + 1
      })
    ).toBe(0)
    // The renderer can die before its children; a child kill shortly *after*
    // the queried instant still counts.
    expect(countSiblingProcessTreeKills({ reason: 'killed', exitCode: 1, at: 900 })).toBe(1)
  })

  it('counts a child kill at exactly the window boundary', () => {
    observeProcessGoneKill(childKill(1_000))

    expect(
      countSiblingProcessTreeKills({
        reason: 'killed',
        exitCode: 1,
        at: 1_000 + PROCESS_TREE_KILL_WINDOW_MS
      })
    ).toBe(1)
  })

  it('pins the boundary on the future side of the queried instant too', () => {
    observeProcessGoneKill(childKill(10_000))

    expect(
      countSiblingProcessTreeKills({
        reason: 'killed',
        exitCode: 1,
        at: 10_000 - PROCESS_TREE_KILL_WINDOW_MS
      })
    ).toBe(1)
    expect(
      countSiblingProcessTreeKills({
        reason: 'killed',
        exitCode: 1,
        at: 10_000 - PROCESS_TREE_KILL_WINDOW_MS - 1
      })
    ).toBe(0)
  })

  // Literal on purpose: the ±2s margin over the observed ≤0.1s field offsets is
  // the contract; a shrunken window would pass every symbolic-constant test.
  it('keeps a kill 1.9s away inside the window', () => {
    observeProcessGoneKill(childKill(1_000))

    expect(countSiblingProcessTreeKills({ reason: 'killed', exitCode: 1, at: 2_900 })).toBe(1)
  })

  // Literal for the same reason on the widen side: a wider window would
  // suppress genuine kills on stale churn evidence, and every symbolic test
  // stretches with the constant.
  it('drops a kill 2.1s away outside the window', () => {
    observeProcessGoneKill(childKill(1_000))

    expect(countSiblingProcessTreeKills({ reason: 'killed', exitCode: 1, at: 3_100 })).toBe(0)
  })

  it('ignores kills with a different reason or exit code', () => {
    observeProcessGoneKill(childKill(1_000, 9))
    observeProcessGoneKill({ at: 1_000, source: 'child', reason: 'crashed', exitCode: 1 })

    expect(countSiblingProcessTreeKills({ reason: 'killed', exitCode: 1, at: 1_000 })).toBe(0)
  })

  it('never lets renderer kills evict the child evidence from the bounded ring', () => {
    observeProcessGoneKill(childKill(1_000))
    for (let i = 0; i < 32; i++) {
      observeProcessGoneKill({ at: 1_001 + i, source: 'renderer', reason: 'killed', exitCode: 1 })
    }

    expect(countSiblingProcessTreeKills({ reason: 'killed', exitCode: 1, at: 1_100 })).toBe(1)
  })

  // A pre-existing churn burst (network service seen at 1459/min) must not pin
  // the ring at stale entries and discard the tree kill's fresh evidence.
  it('evicts the oldest entries first so fresh sibling evidence survives a churn burst', () => {
    for (let i = 0; i < 20; i++) {
      observeProcessGoneKill(childKill(1_000 + i))
    }
    observeProcessGoneKill(childKill(60_000))
    observeProcessGoneKill(childKill(60_040))

    expect(countSiblingProcessTreeKills({ reason: 'killed', exitCode: 1, at: 60_050 })).toBe(2)
  })

  it('bounds the ring so a child kill flood cannot grow it', () => {
    for (let i = 0; i < 64; i++) {
      observeProcessGoneKill(childKill(1_000 + i))
    }

    expect(countSiblingProcessTreeKills({ reason: 'killed', exitCode: 1, at: 1_063 })).toBe(16)
  })
})
