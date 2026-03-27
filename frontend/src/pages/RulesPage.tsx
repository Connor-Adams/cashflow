import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { deleteReq, getJson, postJson } from '../lib/api'
import type { Rule } from '../types/api'

export function RulesPage() {
  const [rules, setRules] = useState<Rule[]>([])
  const [err, setErr] = useState<string | null>(null)

  async function load() {
    setErr(null)
    try {
      setRules(await getJson<Rule[]>('/api/rules'))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Error')
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const fd = new FormData(form)
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
    await load()
  }

  async function remove(id: number) {
    if (!confirm('Delete this rule?')) return
    await deleteReq(`/api/rules/${id}`)
    await load()
  }

  return (
    <div className="page">
      <h1>Rules</h1>
      {err && <span className="error">{err}</span>}
      <form className="card" onSubmit={onCreate}>
        <h2>New rule</h2>
        <div className="formGrid">
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
          <label>
            Category
            <input name="category" placeholder="Groceries" />
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
            {rules.map((r) => (
              <tr key={r.id}>
                <td>{r.merchantPattern}</td>
                <td>{r.matchKind}</td>
                <td>{r.priority}</td>
                <td>{r.category}</td>
                <td>{r.isBusiness ? 'yes' : ''}</td>
                <td>{r.splitType}</td>
                <td>{r.usageCount ?? 0}</td>
                <td>
                  <button type="button" onClick={() => void remove(r.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
