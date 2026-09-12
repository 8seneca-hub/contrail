import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { checkDocs } from '../src/check.js'
import { emptyClientSiteMessage, main, parseAudienceFlag } from '../src/cli.js'
import { buildSite, docsForAudience, pageFileFor } from '../src/emit/site.js'
import { parseDoc } from '../src/parse.js'

const FM = (extra = '') =>
  `---\ntitle: T\nsummary: S\nstatus: current\n${extra}---\n\n`

function writeDocAt(root: string, relPath: string, contents: string) {
  const abs = join(root, relPath)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, contents)
  return parseDoc(abs, root)
}

function setupCliWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'contrail-audience-cli-'))
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(
    join(root, 'contrail.config.ts'),
    "export default { plane: { baseUrl: 'https://plane.test', workspace: 'acme' }, repos: {}, " +
      "docs: ['./docs/**/*.md'] }\n",
  )
  return root
}

async function runInWorkspace(root: string, args: string[]): Promise<{ code: number; logs: string[] }> {
  const logs: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg))
  const cwd = process.cwd()
  process.chdir(root)
  try {
    const code = await main(args)
    return { code, logs }
  } finally {
    process.chdir(cwd)
    spy.mockRestore()
  }
}

describe('client site: omits internal documents entirely', () => {
  it('a client build does not write the internal document\'s output file at all', async () => {
    const root = setupCliWorkspace()
    writeFileSync(
      join(root, 'docs', 'brief.md'),
      `${FM('audience: client\n')}A client-visible brief.\n`,
    )
    writeFileSync(
      join(root, 'docs', 'budget.md'),
      `${FM('docKind: budget\naudience: internal\n')}Internal cost breakdown.\n`,
    )

    const { code } = await runInWorkspace(root, ['site', '--out', './site', '--audience', 'client'])
    expect(code).toBe(0)

    // The file must not exist at all — not merely be unlinked. An unlinked
    // file on a static host is still a public URL.
    expect(existsSync(join(root, 'site', pageFileFor('docs/budget.md')))).toBe(false)
    expect(existsSync(join(root, 'site', pageFileFor('docs/brief.md')))).toBe(true)
  })

  it('a document with `audience` absent is treated as internal by the client build', async () => {
    // Direct unit-level test of the safety default: no CLI, no frontmatter
    // parsing surprises — a bare Doc with the default audience must be
    // excluded from a client build.
    const root = mkdtempSync(join(tmpdir(), 'contrail-audience-default-'))
    const doc = writeDocAt(root, 'docs/unclassified.md', `${FM()}Nobody has classified this yet.\n`)
    expect(doc.frontmatter.audience).toBe('internal')

    const outDir = join(root, 'site')
    const result = await buildSite({ docs: [doc], outDir, cacheDir: join(root, '.cache'), audience: 'client' })

    expect(result.pages).toHaveLength(0)
    expect(existsSync(join(outDir, pageFileFor(doc.key)))).toBe(false)
  })
})

describe('llms.txt filters identically to the site', () => {
  it('the internal document\'s path does not appear anywhere in a client llms.txt', async () => {
    const root = setupCliWorkspace()
    writeFileSync(
      join(root, 'docs', 'brief.md'),
      `${FM('audience: client\nkind: reference\n')}A client-visible brief.\n`,
    )
    writeFileSync(
      join(root, 'docs', 'budget.md'),
      `${FM('docKind: budget\naudience: internal\nkind: reference\n')}Internal cost breakdown.\n`,
    )

    const { code } = await runInWorkspace(root, ['check', '--index', '--audience', 'client'])
    expect(code).toBe(0)

    const llmsTxt = readFileSync(join(root, 'docs', 'llms.txt'), 'utf8')
    expect(llmsTxt).toContain('brief.md')
    expect(llmsTxt).not.toContain('budget.md')
  })
})

describe('client site: links to internal documents are defanged', () => {
  it('rewrites the link as plain text, reports it, and the internal path never reaches the HTML', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-audience-defang-'))
    const budget = writeDocAt(
      root,
      'docs/03-management/budget.md',
      `${FM('docKind: budget\naudience: internal\n')}The real cost breakdown.\n`,
    )
    const brief = writeDocAt(
      root,
      'docs/01-overview/brief.md',
      `${FM('audience: client\n')}See the [project budget](../03-management/budget.md) for detail.\n`,
    )

    const outDir = join(root, 'site')
    const result = await buildSite({
      docs: [budget, brief],
      outDir,
      cacheDir: join(root, '.cache'),
      audience: 'client',
    })

    expect(result.defangedLinks).toEqual([{ doc: brief.key, url: '../03-management/budget.md' }])

    const briefPage = readFileSync(join(outDir, pageFileFor(brief.key)), 'utf8')
    // Plain text survives; the anchor and the href pointing at the budget doc are both gone
    // (the page's own "All documents" breadcrumb link is unrelated and must stay).
    expect(briefPage).toContain('project budget')
    expect(briefPage).not.toContain('budget.md')
    expect(briefPage).not.toMatch(/<a href="[^"]*budget/)

    // Grep the WHOLE output directory, not just the one page: the internal
    // path must not leak into the HTML by any route (a dangling-but-visible
    // href would still name the document).
    for (const file of readdirSync(outDir)) {
      if (!file.endsWith('.html')) continue
      const html = readFileSync(join(outDir, file), 'utf8')
      expect(html).not.toContain('03-management/budget')
      expect(html).not.toContain('budget.md')
    }
    expect(existsSync(join(outDir, pageFileFor(budget.key)))).toBe(false)
  })
})

describe('lint: internal-doc-exposed and unclassified-money-doc', () => {
  it('internal-doc-exposed fires as an error when a money document is marked audience: client', () => {
    const doc = writeDocAt(
      mkdtempSync(join(tmpdir(), 'contrail-audience-lint-')),
      'docs/budget.md',
      `${FM('docKind: budget\naudience: client\n')}Numbers.\n`,
    )
    const findings = checkDocs([doc]).filter((f) => f.rule === 'internal-doc-exposed')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('error')
  })

  it('unclassified-money-doc fires as an error when a money document has no explicit audience', () => {
    const doc = writeDocAt(
      mkdtempSync(join(tmpdir(), 'contrail-audience-lint-')),
      'docs/03-management/budget.md',
      `${FM()}Numbers, no audience set at all.\n`,
    )
    expect(doc.audienceExplicit).toBe(false)
    const findings = checkDocs([doc]).filter((f) => f.rule === 'unclassified-money-doc')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('error')
  })

  it('an explicit audience: internal on a money document satisfies unclassified-money-doc', () => {
    const doc = writeDocAt(
      mkdtempSync(join(tmpdir(), 'contrail-audience-lint-')),
      'docs/estimate.md',
      `${FM('docKind: estimate\naudience: internal\n')}Numbers.\n`,
    )
    const findings = checkDocs([doc])
    expect(findings.filter((f) => f.rule === 'unclassified-money-doc')).toHaveLength(0)
    expect(findings.filter((f) => f.rule === 'internal-doc-exposed')).toHaveLength(0)
  })

  it('a money path with no docKind still triggers on path alone', () => {
    const doc = writeDocAt(
      mkdtempSync(join(tmpdir(), 'contrail-audience-lint-')),
      'docs/03-management/budget.md',
      `${FM('audience: client\n')}Numbers, misfiled with no docKind.\n`,
    )
    expect(checkDocs([doc]).filter((f) => f.rule === 'internal-doc-exposed')).toHaveLength(1)
  })
})

describe('client build of a tree with zero client documents', () => {
  it('produces an empty site and says so, rather than succeeding silently', async () => {
    const root = setupCliWorkspace()
    writeFileSync(join(root, 'docs', 'a.md'), `${FM()}Internal doc A.\n`)
    writeFileSync(join(root, 'docs', 'b.md'), `${FM('docKind: budget\n')}Internal doc B.\n`)

    const { code, logs } = await runInWorkspace(root, ['site', '--out', './site', '--audience', 'client'])
    expect(code).toBe(0)
    expect(logs.join('\n')).toContain('Wrote 0 page(s)')
    expect(logs.join('\n')).toContain(emptyClientSiteMessage())

    expect(existsSync(join(root, 'site', 'index.html'))).toBe(true)
    expect(existsSync(join(root, 'site', pageFileFor('docs/a.md')))).toBe(false)
    expect(existsSync(join(root, 'site', pageFileFor('docs/b.md')))).toBe(false)
  })
})

describe('--audience flag validation', () => {
  it('accepts client and omitted, rejects anything else', () => {
    expect(parseAudienceFlag(undefined)).toBeUndefined()
    expect(parseAudienceFlag('client')).toBe('client')
    expect(() => parseAudienceFlag('internal')).toThrow(/Unknown --audience/)
    expect(() => parseAudienceFlag('everyone')).toThrow(/Unknown --audience/)
  })
})

describe('docsForAudience', () => {
  it('with no filter, returns every document unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-audience-filter-'))
    const a = writeDocAt(root, 'a.md', `${FM('audience: client\n')}A.\n`)
    const b = writeDocAt(root, 'b.md', `${FM()}B.\n`)
    expect(docsForAudience([a, b], undefined)).toEqual([a, b])
  })
})
