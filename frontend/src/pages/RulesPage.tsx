import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useConfirm } from '@/components/ui/dialog'
import { PageHeader } from '@/components/ui/page-header'
import { CategoryCloudPicker } from '../components/CategoryCloudPicker'
import { deleteReq, getJson, postJson } from '../lib/api'
import type { Rule } from '../types/api'

type CategoryHint = {
  label: string
  usageCount: number
}

type RuleProposal = {
  merchantPattern: string
  category: string | null
  isBusiness: boolean
  splitType: string
  pctMe: string | null
  pctPartner: string | null
  supportCount: number
  exampleTransactionIds: number[]
}

export function RulesPage() {
  const [rules, setRules] = useState<Rule[]>([])
  const [proposals, setProposals] = useState<RuleProposal[]>([])
  const [categoryHints, setCategoryHints] = useState<CategoryHint[]>([])
  const [ruleCategory, setRuleCategory] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const loadRequestRef = useRef(0)
  const confirm = useConfirm()
  const categoryLabels = useMemo(
    () => categoryHints.map((hint) => hint.label),
    [categoryHints]
  )

  async function load() {
    const requestId = ++loadRequestRef.current
    setErr(null)
    try {
      const nextRules = await getJson<Rule[]>('/api/rules')
      const nextProposals = await getJson<{ proposals: RuleProposal[] }>(
        '/api/ai/rule-proposals'
      )
      if (loadRequestRef.current === requestId) {
        setRules(nextRules)
        setProposals(nextProposals.proposals)
      }
    } catch (e) {
      if (loadRequestRef.current === requestId) {
        setErr(e instanceof Error ? e.message : 'Error')
      }
    }
  }

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    void getJson<{ categories: CategoryHint[] }>('/api/transactions/category-hints')
      .then((data) => setCategoryHints(data.categories))
      .catch(() => setCategoryHints([]))
  }, [])

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const fd = new FormData(form)
    setErr(null)
    try {
      await postJson('/api/rules', {
        merchantPattern: String(fd.get('merchantPattern') ?? ''),
        matchKind: String(fd.get('matchKind') ?? 'substring'),
        priority: Number(fd.get('priority') ?? 0),
        category: String(fd.get('category') ?? '') || null,
        isBusiness: fd.get('isBusiness') === 'on',
        splitType: String(fd.get('splitType') ?? 'me'),
        pctMe: fd.get('pctMe') ? String(fd.get('pctMe')) : null,
        pctPartner: fd.get('pctPartner') ? String(fd.get('pctPartner')) : null,
      })
      form.reset()
      setRuleCategory('')
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create rule')
    }
  }

  async function remove(rule: Rule) {
    const ok = await confirm({
      title: 'Delete rule?',
      description: `The rule for “${rule.merchantPattern}” will be removed.`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    setErr(null)
    try {
      await deleteReq(`/api/rules/${rule.id}`)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not delete rule')
    }
  }

  async function approveProposal(proposal: RuleProposal) {
    setErr(null)
    try {
      await postJson(
        `/api/ai/rule-proposals/${encodeURIComponent(proposal.merchantPattern)}/approve`,
        proposal
      )
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not approve proposal')
    }
  }

  return (
    <>
    <div className="page">
      <PageHeader
        title="Rules"
        description="Match merchants on import so category, business, and split defaults land in the right place."
      />
      {err && <span className="error">{err}</span>}
      <form className="card rulesFormCard" onSubmit={onCreate}>
        <div className="rulesCardHeader">
          <div>
            <h2>New rule</h2>
            <p className="muted">
              Reuse an existing category when possible to keep reports tidy.
            </p>
          </div>
          <span className="transactionsPanelBadge">
            {categoryLabels.length} categories
          </span>
        </div>
        <div className="formGrid rulesFormGrid">
          <label>
            Pattern
            <input name="merchantPattern" required placeholder="merchant text" />
          </label>
          <label>
            Match
            <select name="matchKind" defaultValue="substring">
              <option value="substring">substring</option>
              <option value="regex">regex</option>
            </select>
          </label>
          <label>
            Priority
            <input name="priority" type="number" defaultValue={0} />
          </label>
          <label className="rulesCategoryField">
            Category
            <CategoryCloudPicker
              className="rulesCategoryPicker"
              cloudClassName="rulesCategoryPickerCloud"
              itemClassName="rulesCategoryPickerItem"
              value={ruleCategory}
              onChange={setRuleCategory}
              options={categoryLabels}
              placeholder="Groceries"
            />
            <input type="hidden" name="category" value={ruleCategory} />
          </label>
          <label className="check">
            <input name="isBusiness" type="checkbox" /> Business
          </label>
          <label>
            Split
            <select name="splitType" defaultValue="me">
              <option value="me">me</option>
              <option value="partner">partner</option>
              <option value="shared">shared</option>
            </select>
          </label>
          <label>
            pct_me (0–1)
            <input name="pctMe" placeholder="0.5" />
          </label>
          <label>
            pct_partner (0–1)
            <input name="pctPartner" placeholder="0.5" />
          </label>
        </div>
        <button type="submit">Add rule</button>
      </form>

      {proposals.length > 0 && (
        <section className="card rulesTableCard">
          <div className="rulesCardHeader">
            <div>
              <h2>AI rule proposals</h2>
              <p className="muted">
                Repeated reviewed merchants that look stable enough to automate.
              </p>
            </div>
            <span className="transactionsPanelBadge">{proposals.length} proposals</span>
          </div>
          <div className="tableWrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Pattern</th>
                  <th>Category</th>
                  <th>Biz</th>
                  <th>Split</th>
                  <th>Support</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {proposals.map((p) => (
                  <tr key={`${p.merchantPattern}-${p.category}-${p.splitType}`}>
                    <td>{p.merchantPattern}</td>
                    <td>{p.category ?? '—'}</td>
                    <td>{p.isBusiness ? 'yes' : ''}</td>
                    <td>{p.splitType}</td>
                    <td>
                      {p.supportCount} rows #{p.exampleTransactionIds.join(', #')}
                    </td>
                    <td>
                      <button type="button" onClick={() => void approveProposal(p)}>
                        Approve
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card rulesTableCard">
        <div className="rulesCardHeader">
          <div>
            <h2>Existing rules</h2>
            <p className="muted">
              Higher priority wins when several patterns match the same transaction.
            </p>
          </div>
          <span className="transactionsPanelBadge">{rules.length} rules</span>
        </div>
        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th>Pattern</th>
                <th>Match</th>
                <th>Pri</th>
                <th>Category</th>
                <th>Biz</th>
                <th>Split</th>
                <th>Usage</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 ? (
                <tr>
                  <td colSpan={8} className="emptyStateCell">
                    <p>No rules yet. Add a pattern above to start automating imports.</p>
                    <p className="muted">
                      Rules set default category, business flag, and split for matching merchants on import.
                    </p>
                  </td>
                </tr>
              ) : (
                rules.map((r) => (
                  <tr key={r.id}>
                    <td>{r.merchantPattern}</td>
                    <td>{r.matchKind}</td>
                    <td>{r.priority}</td>
                    <td>{r.category ?? '—'}</td>
                    <td>{r.isBusiness ? 'yes' : ''}</td>
                    <td>{r.splitType}</td>
                    <td>{r.usageCount ?? 0}</td>
                    <td>
                      <button type="button" onClick={() => void remove(r)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
    {confirm.dialog}
    </>
  )
}
