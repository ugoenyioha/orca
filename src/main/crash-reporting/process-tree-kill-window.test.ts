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

  it('bounds the ring so a child kill flood cannot grow it', () => {
    for (let i = 0; i < 64; i++) {
      observeProcessGoneKill(childKill(1_000 + i))
    }

    expect(countSiblingProcessTreeKills({ reason: 'killed', exitCode: 1, at: 1_063 })).toBe(16)
  })
})
