import { describe, it, expect } from 'vitest'
import {
  COMMANDS,
  filterCommands,
  groupCommandsByCategory,
  scoreCommand,
  type Command,
} from './commands'

describe('command registry', () => {
  it('exposes a non-empty registry', () => {
    expect(COMMANDS.length).toBeGreaterThan(10)
  })

  it('every command has a stable id, label, category, and destination', () => {
    for (const cmd of COMMANDS) {
      expect(cmd.id).toMatch(/^[a-z0-9-]+$/)
      expect(cmd.label).toBeTruthy()
      expect(cmd.category).toBeTruthy()
      expect(cmd.destination.startsWith('/')).toBe(true)
    }
  })

  it('command ids are unique', () => {
    const ids = COMMANDS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('scoreCommand', () => {
  const cmd: Command = {
    id: 'create-rule',
    label: 'Create rule',
    description: 'Add a new auto-categorization rule',
    keywords: ['add', 'automation', 'pattern'],
    category: 'Create',
    destination: '/rules',
  }

  it('scores 0 for empty query', () => {
    expect(scoreCommand(cmd, '')).toBe(0)
    expect(scoreCommand(cmd, '   ')).toBe(0)
  })

  it('exact label match scores highest', () => {
    expect(scoreCommand(cmd, 'create rule')).toBe(100)
    expect(scoreCommand(cmd, 'CREATE RULE')).toBe(100)
  })

  it('label prefix scores 80', () => {
    expect(scoreCommand(cmd, 'create')).toBe(80)
  })

  it('label substring scores 60', () => {
    expect(scoreCommand(cmd, 'rule')).toBe(60)
  })

  it('description substring scores 40', () => {
    expect(scoreCommand(cmd, 'auto-categor')).toBe(40)
  })

  it('keyword prefix scores 30', () => {
    expect(scoreCommand(cmd, 'automa')).toBe(30)
  })

  it('keyword substring scores 20', () => {
    const score = scoreCommand(cmd, 'tomat')
    expect(score).toBe(20)
  })

  it('category match scores 10', () => {
    // 'crea' would prefix-match label "Create rule"; use a command whose
    // category doesn't overlap with its label / description.
    const navCmd: Command = {
      id: 'nav-x',
      label: 'Open xyzzy',
      category: 'Navigate',
      destination: '/x',
    }
    expect(scoreCommand(navCmd, 'naviga')).toBe(10)
  })

  it('returns 0 when nothing matches', () => {
    expect(scoreCommand(cmd, 'zzznope')).toBe(0)
  })

  it('matches diacritic-stripped tokens', () => {
    const cafe: Command = {
      id: 'nav-cafe',
      label: 'Café orders',
      category: 'Navigate',
      destination: '/cafe',
    }
    // 'cafe' should match the label 'Café orders' (NFD strip).
    expect(scoreCommand(cafe, 'cafe')).toBeGreaterThan(0)
  })
})

describe('filterCommands', () => {
  const registry: Command[] = [
    { id: 'a', label: 'Alpha thing', category: 'Navigate', destination: '/a' },
    {
      id: 'b',
      label: 'Beta thing',
      category: 'Create',
      destination: '/b',
      keywords: ['gamma'],
    },
    {
      id: 'c',
      label: 'Contextual action',
      category: 'Context',
      destination: '/c',
      contextMatch: (p) => p.startsWith('/merchants/'),
    },
  ]

  it('returns all non-contextual commands when query is empty and no context', () => {
    const result = filterCommands({ query: '', pathname: '/', registry })
    expect(result.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('floats contextual commands to the top of empty-query results', () => {
    const result = filterCommands({
      query: '',
      pathname: '/merchants/acme',
      registry,
    })
    expect(result[0].id).toBe('c')
  })

  it('hides contextual commands when pathname does not match', () => {
    const result = filterCommands({ query: '', pathname: '/', registry })
    expect(result.find((c) => c.id === 'c')).toBeUndefined()
  })

  it('shows contextual commands when pathname matches', () => {
    const result = filterCommands({
      query: '',
      pathname: '/merchants/acme',
      registry,
    })
    expect(result.find((c) => c.id === 'c')).toBeDefined()
  })

  it('filters by query and orders by score', () => {
    // "thing" appears in both Alpha and Beta labels; both score 60.
    // Tie-broken by registry order → a before b.
    const result = filterCommands({ query: 'thing', pathname: '/', registry })
    expect(result.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('matches keywords', () => {
    const result = filterCommands({ query: 'gamma', pathname: '/', registry })
    expect(result.map((c) => c.id)).toEqual(['b'])
  })

  it('returns an empty list when nothing matches', () => {
    const result = filterCommands({
      query: 'zzznope',
      pathname: '/',
      registry,
    })
    expect(result).toEqual([])
  })

  it('honors limit', () => {
    const result = filterCommands({
      query: '',
      pathname: '/',
      registry,
      limit: 1,
    })
    expect(result).toHaveLength(1)
  })

  it('built-in registry: searching "import" returns import commands', () => {
    const result = filterCommands({ query: 'import', pathname: '/' })
    const ids = result.map((c) => c.id)
    expect(ids).toContain('nav-import')
    expect(ids).toContain('run-import-statement')
  })

  it('built-in registry: contextual commands appear on /merchants/:name', () => {
    const result = filterCommands({
      query: '',
      pathname: '/merchants/Starbucks',
    })
    const contextIds = result.filter((c) => c.category === 'Context').map((c) => c.id)
    expect(contextIds).toContain('ctx-create-rule-from-merchant')
    expect(contextIds).toContain('ctx-view-merchant-transactions')
  })

  it('built-in registry: contextual commands do NOT appear on unrelated pages', () => {
    const result = filterCommands({ query: '', pathname: '/dashboard' })
    const contextIds = result.filter((c) => c.category === 'Context').map((c) => c.id)
    expect(contextIds).toEqual([])
  })
})

describe('groupCommandsByCategory', () => {
  it('groups commands and orders Context first', () => {
    const cmds: Command[] = [
      { id: 'n', label: 'Nav', category: 'Navigate', destination: '/n' },
      { id: 'c', label: 'Ctx', category: 'Context', destination: '/c' },
      { id: 'cr', label: 'Create', category: 'Create', destination: '/cr' },
    ]
    const groups = groupCommandsByCategory(cmds)
    expect(groups.map((g) => g.category)).toEqual([
      'Context',
      'Navigate',
      'Create',
    ])
  })

  it('omits empty categories', () => {
    const cmds: Command[] = [
      { id: 'a', label: 'A', category: 'Navigate', destination: '/a' },
    ]
    const groups = groupCommandsByCategory(cmds)
    expect(groups).toEqual([{ category: 'Navigate', commands: cmds }])
  })

  it('handles empty input', () => {
    expect(groupCommandsByCategory([])).toEqual([])
  })
})
