import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LabelsTab } from './LabelsTab'
import * as api from '../../../lib/api'
import { _resetLabelsCacheForTest } from '../../../lib/useLabels'
import type { Label } from '../../../types/api'

const SAMPLE: Label[] = [
  { id: 1, name: 'tax-deductible', usageCount: 4 },
  { id: 2, name: 'vacation-2026', usageCount: 2 },
]

describe('LabelsTab', () => {
  beforeEach(() => {
    _resetLabelsCacheForTest()
    vi.restoreAllMocks()
  })

  it('shows the empty state when there are no labels', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([] as Label[])
    render(<LabelsTab />)
    expect(
      await screen.findByText(
        'You have not created any labels yet. Add one on any transaction to get started.',
      ),
    ).toBeInTheDocument()
  })

  it('lists labels with their usage count (AC #12)', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue(SAMPLE)
    render(<LabelsTab />)
    await waitFor(() => screen.getByText('tax-deductible'))
    expect(screen.getByText('vacation-2026')).toBeInTheDocument()
    // usage counts rendered
    const row = screen.getByText('tax-deductible').closest('tr') as HTMLElement
    expect(within(row).getByText('4')).toBeInTheDocument()
  })

  it('renames a label via PATCH (AC #12)', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue(SAMPLE)
    const patchSpy = vi
      .spyOn(api, 'patchJson')
      .mockResolvedValue({ id: 1, name: 'deductible', usageCount: 4 })
    render(<LabelsTab />)
    await waitFor(() => screen.getByText('tax-deductible'))

    await userEvent.click(screen.getByRole('button', { name: /rename tax-deductible/i }))
    const input = await screen.findByLabelText('Label name')
    await userEvent.clear(input)
    await userEvent.type(input, 'deductible')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith('/api/labels/1', { name: 'deductible' })
    })
  })

  it('deletes a label after confirming, showing the usage count in the prompt (AC #12)', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue(SAMPLE)
    const delSpy = vi.spyOn(api, 'deleteReq').mockResolvedValue(undefined)
    render(<LabelsTab />)
    await waitFor(() => screen.getByText('tax-deductible'))

    await userEvent.click(screen.getByRole('button', { name: /delete tax-deductible/i }))

    // confirm dialog shows the count-aware copy
    expect(
      await screen.findByText("Delete 'tax-deductible' from 4 transactions? This cannot be undone."),
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(delSpy).toHaveBeenCalledWith('/api/labels/1')
    })
  })

  it('merges a label into another via the merge dialog (AC #12)', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue(SAMPLE)
    const postSpy = vi
      .spyOn(api, 'postJson')
      .mockResolvedValue({ merged: true, sourceId: 1, targetId: 2 })
    render(<LabelsTab />)
    await waitFor(() => screen.getByText('tax-deductible'))

    // open merge for the source label
    await userEvent.click(screen.getByRole('button', { name: /merge tax-deductible/i }))
    expect(await screen.findByText('Merge labels')).toBeInTheDocument()

    // pick the target and confirm
    const select = screen.getByLabelText('Merge into')
    await userEvent.selectOptions(select, '2')
    await userEvent.click(screen.getByRole('button', { name: 'Merge' }))

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith('/api/labels/1/merge-into/2')
    })
  })
})
