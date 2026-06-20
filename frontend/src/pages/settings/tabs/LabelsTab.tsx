import { useState } from 'react'
import type { FormEvent } from 'react'
import { Edit3, GitMerge, Trash2 } from 'lucide-react'
import { Button } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { Dialog } from '@connor-adams/designsystem'
import { useConfirm } from '@/lib/ds-extras'
import { Input } from '@connor-adams/designsystem'
import { Label as FieldLabel } from '@connor-adams/designsystem'
import { NativeSelect } from '@connor-adams/designsystem'
import { deleteReq, patchJson, postJson } from '../../../lib/api'
import { useLabels } from '../../../lib/useLabels'
import { LabelColorPicker } from '../../../components/LabelColorPicker'
import { labelChipStyle } from '../../../lib/labelColors'
import type { Label } from '../../../types/api'

/**
 * Settings → Labels (issue #270, AC #12). Lists the household's labels with
 * usage counts and supports rename, delete (with a count-aware confirm), and
 * merge (delete source + reassign its transactions to a target).
 */
export function LabelsTab() {
  const { labels, refresh } = useLabels()
  const [err, setErr] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<Label | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameColor, setRenameColor] = useState<string | null>(null)
  const [renameSaving, setRenameSaving] = useState(false)
  const [mergeSource, setMergeSource] = useState<Label | null>(null)
  const [mergeTargetId, setMergeTargetId] = useState<string>('')
  const [mergeSaving, setMergeSaving] = useState(false)

  const confirm = useConfirm()

  function openRename(label: Label) {
    setErr(null)
    setRenameTarget(label)
    setRenameValue(label.name)
    setRenameColor(label.color ?? null)
  }

  function closeRename() {
    setRenameTarget(null)
    setRenameValue('')
    setRenameColor(null)
    setRenameSaving(false)
  }

  async function submitRename(e?: FormEvent<HTMLFormElement>) {
    if (e) e.preventDefault()
    if (!renameTarget) return
    const next = renameValue.trim()
    if (!next) return
    setRenameSaving(true)
    setErr(null)
    try {
      await patchJson<Label>(`/api/labels/${renameTarget.id}`, {
        name: next,
        color: renameColor,
      })
      closeRename()
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't save label. Try again.")
      setRenameSaving(false)
    }
  }

  async function removeLabel(label: Label) {
    const count = label.usageCount ?? 0
    const ok = await confirm({
      title: 'Delete label',
      description: `Delete '${label.name}' from ${count} transaction${count === 1 ? '' : 's'}? This cannot be undone.`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    setErr(null)
    try {
      await deleteReq(`/api/labels/${label.id}`)
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't delete label. Try again.")
    }
  }

  function openMerge(label: Label) {
    setErr(null)
    setMergeSource(label)
    const firstOther = labels.find((l) => l.id !== label.id)
    setMergeTargetId(firstOther ? String(firstOther.id) : '')
  }

  function closeMerge() {
    setMergeSource(null)
    setMergeTargetId('')
    setMergeSaving(false)
  }

  async function submitMerge(e?: FormEvent<HTMLFormElement>) {
    if (e) e.preventDefault()
    if (!mergeSource || !mergeTargetId) return
    setMergeSaving(true)
    setErr(null)
    try {
      await postJson(`/api/labels/${mergeSource.id}/merge-into/${mergeTargetId}`)
      closeMerge()
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't merge labels. Try again.")
      setMergeSaving(false)
    }
  }

  const mergeTarget = mergeSource
    ? labels.find((l) => String(l.id) === mergeTargetId)
    : null
  const mergeCandidates = mergeSource
    ? labels.filter((l) => l.id !== mergeSource.id)
    : []

  return (
    <Card className="accountsFormCard">
      <div className="accountsCardHeader">
        <div>
          <h2>Labels</h2>
          <p className="muted">
            Labels are cross-cutting tags you attach to transactions. Manage them
            here; add new ones from any transaction.
          </p>
        </div>
      </div>

      {err && (
        <span className="error" role="alert">
          {err}
        </span>
      )}

      {labels.length === 0 ? (
        <p className="muted">
          You have not created any labels yet. Add one on any transaction to get
          started.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-2 font-medium">Label</th>
              <th className="py-2 font-medium">Used by</th>
              <th className="py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {labels.map((label) => (
              <tr key={label.id} className="border-t border-border">
                <td className="py-2">
                  <span
                    className="inline-flex items-center rounded-full border border-transparent bg-muted px-2 py-0.5 text-xs font-medium text-foreground"
                    style={labelChipStyle(label.color)}
                  >
                    {label.name}
                  </span>
                </td>
                <td className="py-2">{label.usageCount ?? 0}</td>
                <td className="py-2">
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      aria-label={`Rename ${label.name}`}
                      onClick={() => openRename(label)}
                    >
                      <Edit3 aria-hidden="true" />
                      Rename
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={`Merge ${label.name}`}
                      disabled={labels.length < 2}
                      onClick={() => openMerge(label)}
                    >
                      <GitMerge aria-hidden="true" />
                      Merge
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      aria-label={`Delete ${label.name}`}
                      onClick={() => void removeLabel(label)}
                    >
                      <Trash2 aria-hidden="true" />
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {renameTarget && (
        <Dialog open onClose={closeRename} title={<>Edit label</>}>
          <form onSubmit={submitRename}>
            <FieldLabel htmlFor="label-rename-name">
              Label name
              <Input
                id="label-rename-name"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                maxLength={32}
                required
                autoComplete="off"
              />
            </FieldLabel>
            <div className="mt-3">
              <span className="text-sm font-medium">Color</span>
              <div className="mt-1.5">
                <LabelColorPicker
                  value={renameColor}
                  onChange={setRenameColor}
                  disabled={renameSaving}
                />
              </div>
            </div>
            <div className="mt-2 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={closeRename}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  renameSaving ||
                  !renameValue.trim() ||
                  (renameValue.trim() === renameTarget.name &&
                    (renameColor ?? null) === (renameTarget.color ?? null))
                }
              >
                Save label
              </Button>
            </div>
          </form>
        </Dialog>
      )}

      {mergeSource && (
        <Dialog open onClose={closeMerge} title={<>Merge labels</>}>
          <form onSubmit={submitMerge}>
            <p className="mb-3">
              {mergeTarget
                ? `Move all transactions tagged '${mergeSource.name}' to '${mergeTarget.name}'? '${mergeSource.name}' will be deleted.`
                : `Move all transactions tagged '${mergeSource.name}' to another label? '${mergeSource.name}' will be deleted.`}
            </p>
            <FieldLabel htmlFor="label-merge-target">
              Merge into
              <NativeSelect
                id="label-merge-target"
                value={mergeTargetId}
                onChange={(e) => setMergeTargetId(e.target.value)}
              >
                {mergeCandidates.map((l) => (
                  <option key={l.id} value={String(l.id)}>
                    {l.name}
                  </option>
                ))}
              </NativeSelect>
            </FieldLabel>
            <div className="mt-2 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={closeMerge}>
                Cancel
              </Button>
              <Button type="submit" disabled={mergeSaving || !mergeTargetId}>
                Merge
              </Button>
            </div>
          </form>
        </Dialog>
      )}
      {confirm.dialog}
    </Card>
  )
}
