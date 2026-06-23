/**
 * Encrypted finance vault page (issue #241).
 *
 * Surfaces the documents stored in /api/vault/documents with upload, search,
 * tag filter, linked-entity filter, rename, and delete. The list view stays
 * intentionally compact — the goal of this page is to confirm a document is
 * stored safely and find it again, not to be a full DAM UI.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { Badge, Icon } from '@connor-adams/designsystem'
import { Button } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { useConfirm } from '@/lib/ds-extras'
import { EmptyTableRow } from '@/lib/ds-extras'
import { Input } from '@connor-adams/designsystem'
import { Label } from '@connor-adams/designsystem'
import { NativeSelect } from '@connor-adams/designsystem'
import { PageHeader } from '@/components/ui/page-header'
import { SkeletonRow } from '@/lib/ds-extras'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@connor-adams/designsystem'
import { useToast } from '@/components/ui/toast'
import { deleteReq, getJson, postFormData } from '../lib/api'

const VAULT_LINKED_ENTITY_TYPES = [
  '',
  'transaction',
  'merchant',
  'account',
  'tax_year',
  'purchase',
] as const

const VAULT_VISIBILITIES = ['shared', 'private'] as const

type VaultLinkedEntityType =
  | 'transaction'
  | 'merchant'
  | 'account'
  | 'tax_year'
  | 'purchase'

type VaultVisibility = (typeof VAULT_VISIBILITIES)[number]

type VaultDocument = {
  id: number
  householdId: number
  uploadedByUserId: number | null
  visibility: VaultVisibility
  originalName: string
  mimeType: string
  sizeBytes: number
  storageKind: 'local' | 's3'
  encryptionAlgorithm: 'aes-256-gcm' | 'none'
  encryptionKeyVersion: number
  tags: string[]
  linkedEntityType: VaultLinkedEntityType | null
  linkedEntityId: number | null
  description: string | null
  createdAt: string
  updatedAt: string
}

type VaultListResponse = {
  data: VaultDocument[]
  count: number
  encryptionConfigured: boolean
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

export function VaultPage() {
  const [docs, setDocs] = useState<VaultDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [encryptionConfigured, setEncryptionConfigured] = useState(true)
  const [q, setQ] = useState('')
  const [tag, setTag] = useState('')
  const [linkedType, setLinkedType] = useState<string>('')
  const { showToast } = useToast()
  const confirm = useConfirm()

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (q.trim()) params.set('q', q.trim())
      if (tag.trim()) params.set('tag', tag.trim())
      if (linkedType) params.set('linkedType', linkedType)
      const qs = params.toString()
      const res = await getJson<VaultListResponse>(
        `/api/vault/documents${qs ? `?${qs}` : ''}`,
      )
      setDocs(res.data)
      setEncryptionConfigured(res.encryptionConfigured)
    } catch (err) {
      showToast({
        title: err instanceof Error ? err.message : 'Failed to load vault',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [q, tag, linkedType, showToast])

  useEffect(() => {
    void reload()
  }, [reload])

  async function handleUpload(form: VaultUploadForm) {
    const fd = new FormData()
    fd.append('file', form.file)
    if (form.tags.trim()) fd.append('tags', form.tags.trim())
    if (form.visibility) fd.append('visibility', form.visibility)
    if (form.linkedEntityType) fd.append('linkedEntityType', form.linkedEntityType)
    if (form.linkedEntityId.trim()) fd.append('linkedEntityId', form.linkedEntityId.trim())
    if (form.description.trim()) fd.append('description', form.description.trim())
    await postFormData<{ data: VaultDocument }>('/api/vault/documents', fd)
    showToast({ title: `Uploaded "${form.file.name}"`, variant: 'success' })
    await reload()
  }

  async function handleDelete(doc: VaultDocument) {
    const ok = await confirm({
      title: 'Delete vault document?',
      description: `"${doc.originalName}" will be removed permanently.`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    await deleteReq(`/api/vault/documents/${doc.id}`)
    showToast({ title: `Deleted "${doc.originalName}"`, variant: 'success' })
    await reload()
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Vault"
        description="Receipts, statements, tax slips, invoices, warranties, and contracts. Stored encrypted at rest."
      />

      {!encryptionConfigured ? (
        <Card className="border-warning bg-warning-bg p-4">
          <div className="flex gap-3">
            <Icon name="shield-alert" className="text-warning" aria-hidden="true" />
            <div className="text-sm">
              <p className="font-medium">Vault encryption is not configured.</p>
              <p className="text-muted-foreground">
                Documents are being stored as plaintext. Set
                {' '}
                <code>VAULT_ENCRYPTION_KEY</code> (or
                {' '}
                <code>EMAIL_INTEGRATION_ENCRYPTION_KEY</code>) to a 64-character
                hex string to enable AES-256-GCM encryption at rest.
              </p>
            </div>
          </div>
        </Card>
      ) : null}

      <UploadCard onUpload={handleUpload} />

      <Card className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label htmlFor="vault-search">Search</Label>
            <Input
              id="vault-search"
              type="search"
              placeholder="Name or description"
              value={q}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setQ(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="vault-tag">Tag</Label>
            <Input
              id="vault-tag"
              type="search"
              placeholder="e.g. tax-2024"
              value={tag}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setTag(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="vault-linked-type">Linked to</Label>
            <NativeSelect
              id="vault-linked-type"
              value={linkedType}
              onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                setLinkedType(e.target.value)
              }
            >
              {VAULT_LINKED_ENTITY_TYPES.map((opt) => (
                <option key={opt || 'any'} value={opt}>
                  {opt === '' ? 'Any' : opt.replace('_', ' ')}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Tags</TableHead>
              <TableHead>Linked to</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Encryption</TableHead>
              <TableHead>Uploaded</TableHead>
              <TableHead className="w-32 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <>
                <SkeletonRow cols={7} />
                <SkeletonRow cols={7} />
                <SkeletonRow cols={7} />
              </>
            ) : docs.length === 0 ? (
              <EmptyTableRow
                colSpan={7}
                title="No vault documents yet"
                description="Upload receipts, statements, tax files, invoices, warranties, or contracts to keep them in one encrypted place."
              />
            ) : (
              docs.map((doc) => <VaultRow key={doc.id} doc={doc} onDelete={handleDelete} />)
            )}
          </TableBody>
        </Table>
      </Card>
      {confirm.dialog}
    </div>
  )
}

type VaultUploadForm = {
  file: File
  tags: string
  visibility: VaultVisibility
  linkedEntityType: VaultLinkedEntityType | ''
  linkedEntityId: string
  description: string
}

function UploadCard({ onUpload }: { onUpload: (form: VaultUploadForm) => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null)
  const [tags, setTags] = useState('')
  const [visibility, setVisibility] = useState<VaultVisibility>('shared')
  const [linkedEntityType, setLinkedEntityType] = useState<VaultLinkedEntityType | ''>('')
  const [linkedEntityId, setLinkedEntityId] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const { showToast } = useToast()

  function resetForm() {
    setFile(null)
    setTags('')
    setVisibility('shared')
    setLinkedEntityType('')
    setLinkedEntityId('')
    setDescription('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!file) {
      showToast({ title: 'Choose a file to upload', variant: 'destructive' })
      return
    }
    setSubmitting(true)
    try {
      await onUpload({
        file,
        tags,
        visibility,
        linkedEntityType,
        linkedEntityId,
        description,
      })
      resetForm()
    } catch (err) {
      showToast({
        title: err instanceof Error ? err.message : 'Upload failed',
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card className="p-4">
      <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="md:col-span-2">
          <Label htmlFor="vault-file">File</Label>
          <input
            id="vault-file"
            ref={fileInputRef}
            type="file"
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const f = e.target.files?.[0] ?? null
              setFile(f)
            }}
          />
        </div>
        <div>
          <Label htmlFor="vault-tags">Tags (comma-separated)</Label>
          <Input
            id="vault-tags"
            placeholder="tax-2024, invoice"
            value={tags}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setTags(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="vault-visibility">Visibility</Label>
          <NativeSelect
            id="vault-visibility"
            value={visibility}
            onChange={(e: ChangeEvent<HTMLSelectElement>) =>
              setVisibility(e.target.value as VaultVisibility)
            }
          >
            {VAULT_VISIBILITIES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div>
          <Label htmlFor="vault-linked-type-upload">Link to entity (optional)</Label>
          <NativeSelect
            id="vault-linked-type-upload"
            value={linkedEntityType}
            onChange={(e: ChangeEvent<HTMLSelectElement>) =>
              setLinkedEntityType(e.target.value as VaultLinkedEntityType | '')
            }
          >
            {VAULT_LINKED_ENTITY_TYPES.map((opt) => (
              <option key={opt || 'any'} value={opt}>
                {opt === '' ? 'None' : opt.replace('_', ' ')}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div>
          <Label htmlFor="vault-linked-id">Linked id (optional)</Label>
          <Input
            id="vault-linked-id"
            placeholder="e.g. transaction id"
            value={linkedEntityId}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setLinkedEntityId(e.target.value)}
            disabled={!linkedEntityType}
          />
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="vault-description">Description (optional)</Label>
          <Input
            id="vault-description"
            placeholder="One-line summary"
            value={description}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setDescription(e.target.value)}
          />
        </div>
        <div className="md:col-span-2 flex justify-end">
          <Button type="submit" disabled={submitting || !file}>
            <Icon name="upload" size={16} aria-hidden="true" />
            {submitting ? 'Uploading…' : 'Upload'}
          </Button>
        </div>
      </form>
    </Card>
  )
}

function VaultRow({
  doc,
  onDelete,
}: {
  doc: VaultDocument
  onDelete: (doc: VaultDocument) => Promise<void>
}) {
  const linked = useMemo(() => {
    if (!doc.linkedEntityType) return null
    if (doc.linkedEntityId == null) return doc.linkedEntityType
    return `${doc.linkedEntityType.replace('_', ' ')} #${doc.linkedEntityId}`
  }, [doc.linkedEntityType, doc.linkedEntityId])

  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-col">
          <span className="font-medium">{doc.originalName}</span>
          {doc.description ? (
            <span className="text-xs text-muted-foreground">{doc.description}</span>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {doc.tags.length === 0 ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            doc.tags.map((t) => (
              <Badge key={t} variant="secondary">
                {t}
              </Badge>
            ))
          )}
        </div>
      </TableCell>
      <TableCell>
        {linked ? (
          <Badge variant="outline">{linked}</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>{formatBytes(doc.sizeBytes)}</TableCell>
      <TableCell>
        {doc.encryptionAlgorithm === 'aes-256-gcm' ? (
          <Badge variant="secondary">
            <Icon name="lock" size={12} aria-hidden="true" />
            AES-256-GCM
          </Badge>
        ) : (
          <Badge variant="outline">none</Badge>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{formatDate(doc.createdAt)}</TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          <a href={`/api/vault/documents/${doc.id}/file`} target="_blank" rel="noreferrer">
            <Button type="button" variant="ghost" size="sm" title="Download">
              <Icon name="download" size={16} aria-hidden="true" />
            </Button>
          </a>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            title="Delete"
            onClick={() => void onDelete(doc)}
          >
            <Icon name="trash" size={16} aria-hidden="true" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}
