import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { main } from '../src/cli.js'
import { PREVIEW_MANIFEST, previewDrift } from '../src/preview.js'

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'contrail-preview-'))
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(
    join(root, 'docs', 'charter.md'),
    '---\ntitle: Project Charter\nsummary: The mandate.\nstatus: current\n---\n\nThe operations director sponsors this.\n',
  )
  writeFileSync(
    join(root, 'contrail.config.ts'),
    "export default { plane: { baseUrl: 'https://plane.test', workspace: 'acme' }, repos: {}, " +
      "docs: ['./docs/**/*.md'], selfhost: { target: 'plane', projectId: 'p1' } }\n",
  )
  return root
}

async function run(root: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => out.push(m))
  const errSpy = vi.spyOn(console, 'error').mockImplementation((m: string) => err.push(m))
  const cwd = process.cwd()
  process.chdir(root)
  try {
    const code = await main(args)
    return { code, out: out.join('\n'), err: err.join('\n') }
  } finally {
    process.chdir(cwd)
    logSpy.mockRestore()
    errSpy.mockRestore()
  }
}

describe('contrail preview', () => {
  it('builds the human-readable HTML and prints an openable URL for it', async () => {
    const root = workspace()
    const { code, out } = await run(root, ['preview'])
    expect(code).toBe(0)
    expect(out).toContain('file://')
    expect(out).toMatch(/index\.html/)
    // Guards the async-call bug this test originally let through: a missing
    // await printed "Built undefined page(s)" and still matched on file://.
    expect(out).toMatch(/Built 1 page\(s\)/)
    expect(out).toMatch(/1 markdown file\(s\) for agents/)
    // Omitting --audience means every document, i.e. the internal build. It
    // must name that, not print the raw undefined.
    expect(out).toContain('for internal')
    expect(out).not.toMatch(/undefined/)
  })

  it('records what it built from, so a later deploy can tell whether it still matches', async () => {
    const root = workspace()
    await run(root, ['preview'])
    const manifest = JSON.parse(readFileSync(join(root, 'site', PREVIEW_MANIFEST), 'utf8')) as {
      docs: Record<string, string>
    }
    expect(Object.keys(manifest.docs)).toEqual(['docs/charter.md'])
  })
})

describe('previewDrift', () => {
  it('reports nothing when the documents are untouched since the preview', async () => {
    const root = workspace()
    await run(root, ['preview'])
    expect(previewDrift(root, join(root, 'site'))).toEqual([])
  })

  it('names a document edited after the preview was confirmed', async () => {
    const root = workspace()
    await run(root, ['preview'])
    writeFileSync(
      join(root, 'docs', 'charter.md'),
      '---\ntitle: Project Charter\nsummary: The mandate.\nstatus: current\n---\n\nActually the CFO sponsors this.\n',
    )
    expect(previewDrift(root, join(root, 'site'))).toEqual(['docs/charter.md'])
  })

  it('names a document added after the preview', async () => {
    const root = workspace()
    await run(root, ['preview'])
    writeFileSync(
      join(root, 'docs', 'scope.md'),
      '---\ntitle: Project Scope\nsummary: In and out.\nstatus: current\n---\n\nIn scope: the translation pipeline.\n',
    )
    expect(previewDrift(root, join(root, 'site'))).toEqual(['docs/scope.md'])
  })

  it('reports nothing when no preview was ever taken — the guard must not block a plain deploy', () => {
    const root = workspace()
    expect(previewDrift(root, join(root, 'site'))).toEqual([])
  })
})

describe('deploy against a confirmed preview', () => {
  it('refuses when a document changed after the preview, naming it', async () => {
    const root = workspace()
    await run(root, ['preview'])
    writeFileSync(
      join(root, 'docs', 'charter.md'),
      '---\ntitle: Project Charter\nsummary: The mandate.\nstatus: current\n---\n\nActually the CFO sponsors this.\n',
    )
    const { code, err } = await run(root, ['deploy', '--target', 'plane'])
    expect(code).toBe(1)
    expect(err).toContain('docs/charter.md')
    expect(err).toMatch(/preview/i)
  })

  it('--force ships anyway for someone who has decided', async () => {
    const root = workspace()
    await run(root, ['preview'])
    writeFileSync(
      join(root, 'docs', 'charter.md'),
      '---\ntitle: Project Charter\nsummary: The mandate.\nstatus: current\n---\n\nActually the CFO sponsors this.\n',
    )
    const { err } = await run(root, ['deploy', '--target', 'plane', '--force'])
    expect(err).not.toMatch(/differs from the preview/i)
  })
})
