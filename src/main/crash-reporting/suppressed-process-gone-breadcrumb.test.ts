import { describe, expect, it } from 'vitest'
import { buildSuppressedProcessGoneBreadcrumbData } from './suppressed-process-gone-breadcrumb'

describe('buildSuppressedProcessGoneBreadcrumbData', () => {
  it('preserves child process identity on suppressed breadcrumbs', () => {
    expect(
      buildSuppressedProcessGoneBreadcrumbData({
        source: 'child',
        processType: 'Utility',
        reason: 'killed',
        exitCode: 1,
        expectedTeardown: 'app-shutdown',
        details: {
          name: 'Network Service',
          serviceName: 'network.mojom.NetworkService',
          nested: { ignored: true }
        }
      })
    ).toEqual({
      source: 'child',
      processType: 'Utility',
      reason: 'killed',
      exitCode: 1,
      expectedTeardown: 'app-shutdown',
      name: 'Network Service',
      serviceName: 'network.mojom.NetworkService'
    })
  })

  it('drops empty and non-string identity fields', () => {
    expect(
      buildSuppressedProcessGoneBreadcrumbData({
        source: 'renderer',
        processType: 'renderer',
        reason: 'crashed',
        exitCode: null,
        expectedTeardown: 'none',
        details: { name: '', serviceName: 42, type: undefined }
      })
    ).toEqual({
      source: 'renderer',
      processType: 'renderer',
      reason: 'crashed',
      exitCode: null,
      expectedTeardown: 'none'
    })
  })
})
