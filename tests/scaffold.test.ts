import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { main } from '../src/cli.js'
import { loadConfig } from '../src/config.js'
import { parseDoc } from '../src/parse.js'
import { runInitTemplate, scaffoldDoc } from '../src/scaffold.js'

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'contrail-scaffold-'))
}

function allMarkdownFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...allMarkdownFiles(full))
    } else if (entry.endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

describe('runInitTemplate', () => {
  it('creates the full agency-project tree on an empty dir', () => {
    const root = tmpRoot()
    const result = runInitTemplate(root, { client: 'Acme', project: 'Website Revamp', startDate: '2026-01-05' })

    expect(existsSync(join(root, 'contrail.config.ts'))).toBe(true)
    expect(existsSync(join(root, 'docs', '00-meta', 'project.yml'))).toBe(true)
    expect(existsSync(join(root, 'docs', '01-overview', 'charter.md'))).toBe(true)
    expect(existsSync(join(root, 'docs', '02-planning', 'wbs.md'))).toBe(true)
    expect(existsSync(join(root, 'docs', '03-management', 'meetings', 'README.md'))).toBe(true)
    expect(existsSync(join(root, 'docs', '04-technical', 'prd.md'))).toBe(true)
    expect(existsSync(join(root, 'docs', '05-delivery', 'closure.md'))).toBe(true)

    expect(result.skipped).toEqual([])
    expect(result.created.length).toBeGreaterThan(30)

    const projectYml = readFileSync(join(root, 'docs', '00-meta', 'project.yml'), 'utf8')
    expect(projectYml).toContain('Acme')
    expect(projectYml).toContain('Website Revamp')
    expect(projectYml).toContain('2026-01-05')
    // Safety: contrail generates docs, it does not run the workflow — no
    // phase, step, or external-system id belongs in project.yml.
    expect(projectYml).not.toMatch(/phase|step|plane/i)
  })

  it('is idempotent: running it twice creates nothing new and overwrites nothing', () => {
    const root = tmpRoot()
    runInitTemplate(root)
    const second = runInitTemplate(root)

    expect(second.created).toEqual([])
    expect(second.skipped.length).toBeGreaterThan(30)
  })

  it('never overwrites a file someone has already edited', () => {
    const root = tmpRoot()
    runInitTemplate(root)

    const charterPath = join(root, 'docs', '01-overview', 'charter.md')
    const edited = '---\ntitle: My Real Charter\nsummary: Written by a human.\nstatus: current\n---\n\nReal content.\n'
    writeFileSync(charterPath, edited)

    const result = runInitTemplate(root)

    expect(readFileSync(charterPath, 'utf8')).toBe(edited)
    expect(result.skipped.some((key) => key.endsWith('charter.md'))).toBe(true)
    expect(result.created.some((key) => key.endsWith('charter.md'))).toBe(false)
  })

  it('only adds what is new when run again after a template gains a file', () => {
    // Simulates "add a template file, run init again": delete one file from
    // an otherwise-scaffolded tree, then re-run — only that file reappears.
    const root = tmpRoot()
    runInitTemplate(root)
    const glossaryPath = join(root, 'docs', '01-overview', 'glossary.md')
    rmSync(glossaryPath)

    const result = runInitTemplate(root)

    expect(existsSync(glossaryPath)).toBe(true)
    expect(result.created).toEqual(['docs/01-overview/glossary.md'])
  })

  it('every scaffolded stub passes `contrail check`', async () => {
    const root = tmpRoot()
    runInitTemplate(root)

    const cwd = process.cwd()
    process.chdir(root)
    let code: number
    try {
      code = await main(['check'])
    } finally {
      process.chdir(cwd)
    }
    expect(code).toBe(0)
  })

  it('every scaffolded stub parses with valid frontmatter (title, summary, status, audience default)', () => {
    const root = tmpRoot()
    runInitTemplate(root)
    const config = loadConfig(join(root, 'contrail.config.ts'))

    for (const path of allMarkdownFiles(join(root, 'docs'))) {
      const parsed = parseDoc(path, config.root)
      expect(parsed.frontmatter.title).toBeTruthy()
      expect(parsed.frontmatter.summary).toBeTruthy()
      expect(parsed.frontmatter.status).toBe('draft')
      expect(parsed.frontmatter.audience).toBe('internal')
    }
  })
})

describe('scaffoldDoc', () => {
  it('produces a document whose frontmatter validates', () => {
    const root = tmpRoot()
    const path = join(root, 'adr-001.md')
    const written = scaffoldDoc('adr', path)

    const doc = parseDoc(written, root)
    expect(doc.frontmatter.docKind).toBe('adr')
    expect(doc.frontmatter.section).toBe('03-management')
    expect(doc.frontmatter.audience).toBe('internal')
    expect(doc.frontmatter.status).toBe('draft')
  })

  it('rejects an unknown docKind, naming the valid set', () => {
    const root = tmpRoot()
    expect(() => scaffoldDoc('not-a-kind', join(root, 'x.md'))).toThrow(/not-a-kind/)
    expect(() => scaffoldDoc('not-a-kind', join(root, 'x.md'))).toThrow(/adr/)
  })

  it('refuses to overwrite an existing file at the target path', () => {
    const root = tmpRoot()
    const path = join(root, 'existing.md')
    writeFileSync(path, 'untouched')
    expect(() => scaffoldDoc('prd', path)).toThrow(/already exists/)
    expect(readFileSync(path, 'utf8')).toBe('untouched')
  })
})

describe('contrail init --template agency-project (via main)', () => {
  it('scaffolds the tree and reports created/skipped, exiting 0', async () => {
    const root = tmpRoot()
    const logs: string[] = []
    const cwd = process.cwd()
    process.chdir(root)
    let code: number
    try {
      const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg))
      code = await main(['init', '--template', 'agency-project'])
      spy.mockRestore()
    } finally {
      process.chdir(cwd)
    }

    expect(code).toBe(0)
    expect(existsSync(join(root, 'docs', '01-overview', 'charter.md'))).toBe(true)
    expect(logs.some((l) => l.includes('created'))).toBe(true)
  })

  it('rejects an unknown template name', async () => {
    const root = tmpRoot()
    const cwd = process.cwd()
    process.chdir(root)
    let code: number
    try {
      code = await main(['init', '--template', 'bogus'])
    } finally {
      process.chdir(cwd)
    }
    expect(code).toBe(2)
  })

  it('plain `contrail init` (no --template) still writes only contrail.config.ts', async () => {
    const root = tmpRoot()
    const cwd = process.cwd()
    process.chdir(root)
    let code: number
    try {
      code = await main(['init'])
    } finally {
      process.chdir(cwd)
    }
    expect(code).toBe(0)
    expect(existsSync(join(root, 'contrail.config.ts'))).toBe(true)
    expect(existsSync(join(root, 'docs'))).toBe(false)
  })
})

describe('contrail scaffold <docKind> <path> (via main)', () => {
  it('creates one document with correct frontmatter', async () => {
    const root = tmpRoot()
    const cwd = process.cwd()
    process.chdir(root)
    let code: number
    try {
      code = await main(['scaffold', 'meeting', 'notes.md'])
    } finally {
      process.chdir(cwd)
    }
    expect(code).toBe(0)
    const doc = parseDoc(join(root, 'notes.md'), root)
    expect(doc.frontmatter.docKind).toBe('meeting')
  })
})
