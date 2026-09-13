import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildLlmsTxt, checkDocs } from '../src/check.js'
import { main } from '../src/cli.js'
import { buildSite, pageFileFor } from '../src/emit/site.js'
import { parseDoc } from '../src/parse.js'

const FM = (extra = '') => `---\ntitle: Doc\nsummary: S\nstatus: current\n${extra}---\n\n`

function writeDoc(root: string, name: string, contents: string) {
  const path = join(root, name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, contents)
  return parseDoc(path, root)
}

async function runInWorkspace(root: string, args: string[]): Promise<{ code: number; logs: string[] }> {
  const logs: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg))
  const cwd = process.cwd()
  process.chdir(root)
  try {
    return { code: await main(args), logs }
  } finally {
    process.chdir(cwd)
    spy.mockRestore()
  }
}

describe('Task 3: canonical link tag', () => {
  it("a page gets a canonical link tag against this build's own configured site URL", async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-canonical-'))
    const doc = writeDoc(root, 'doc.md', FM())
    const outDir = join(root, 'out')
    await buildSite({ docs: [doc], outDir, cacheDir: join(root, '.cache'), siteUrl: 'https://internal.example.com' })

    const page = readFileSync(join(outDir, 'doc.html'), 'utf8')
    expect(page).toContain('<link rel="canonical" href="https://internal.example.com/doc.html">')

    const index = readFileSync(join(outDir, 'index.html'), 'utf8')
    expect(index).toContain('<link rel="canonical" href="https://internal.example.com/index.html">')
  })

  it('no configured site URL emits no canonical tag at all — relative links still work', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-canonical-none-'))
    const doc = writeDoc(root, 'doc.md', FM())
    const outDir = join(root, 'out')
    await buildSite({ docs: [doc], outDir, cacheDir: join(root, '.cache') })

    const page = readFileSync(join(outDir, 'doc.html'), 'utf8')
    expect(page).not.toContain('rel="canonical"')
  })
})

describe('Task 3: llms.txt absolute URLs', () => {
  function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), 'contrail-llms-url-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    return root
  }

  function writeConfig(root: string, siteConfig: string): void {
    writeFileSync(
      join(root, 'contrail.config.ts'),
      "export default { plane: { baseUrl: 'https://plane.test', workspace: 'acme' }, repos: {}, " +
        `docs: ['./docs/**/*.md'], ${siteConfig} }\n`,
    )
  }

  it('an internal build emits absolute URLs against `site.internalUrl`', async () => {
    const root = workspace()
    writeConfig(root, "site: { host: 'vercel', internalUrl: 'https://internal.example.com', clientUrl: 'https://client.example.com' }")
    writeFileSync(join(root, 'docs', 'brief.md'), `${FM()}Body.\n`)

    const { code } = await runInWorkspace(root, ['site', '--out', './site'])
    expect(code).toBe(0)

    const llmsTxt = readFileSync(join(root, 'site', 'llms.txt'), 'utf8')
    expect(llmsTxt).toContain('(https://internal.example.com/brief.html)')
    expect(llmsTxt).not.toContain('client.example.com')
  })

  it('a client build emits absolute URLs against `site.clientUrl`', async () => {
    const root = workspace()
    writeConfig(root, "site: { host: 'vercel', internalUrl: 'https://internal.example.com', clientUrl: 'https://client.example.com' }")
    writeFileSync(join(root, 'docs', 'brief.md'), `${FM('audience: client\n')}Body.\n`)

    const { code } = await runInWorkspace(root, ['site', '--out', './site', '--audience', 'client'])
    expect(code).toBe(0)

    const llmsTxt = readFileSync(join(root, 'site', 'llms.txt'), 'utf8')
    expect(llmsTxt).toContain('(https://client.example.com/brief.html)')
    expect(llmsTxt).not.toContain('internal.example.com')
  })

  it('a build with no configured URL keeps writing relative links in llms.txt', async () => {
    const root = workspace()
    writeConfig(root, '')
    writeFileSync(join(root, 'docs', 'brief.md'), `${FM()}Body.\n`)

    const { code } = await runInWorkspace(root, ['site', '--out', './site'])
    expect(code).toBe(0)

    const llmsTxt = readFileSync(join(root, 'site', 'llms.txt'), 'utf8')
    expect(llmsTxt).toContain('(brief.html)')
  })

  it('buildLlmsTxt with no `baseUrl` keeps the path bare (direct unit check)', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-llms-url-unit-'))
    const doc = writeDoc(root, 'docs/brief.md', FM())
    const config = { root, plane: { baseUrl: 'https://plane.test', workspace: 'acme' }, repos: {}, docs: ['./docs/**/*.md'] }
    const txt = buildLlmsTxt(config, [doc], { linkFor: () => pageFileFor(doc.key) })
    expect(txt).toContain('(brief.html)')
  })
})

describe('Task 3: `client-doc-links-internal` — a client document must never link to the internal site', () => {
  it('errors when a client-visible document links to the configured `internalUrl`', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-internal-leak-'))
    const doc = writeDoc(
      root,
      'docs/brief.md',
      `${FM('audience: client\n')}See [the internal portal](https://internal.example.com/budget.html) for detail.\n`,
    )

    const findings = checkDocs([doc], { internalUrl: 'https://internal.example.com' })
    const leaks = findings.filter((f) => f.rule === 'client-doc-links-internal')
    expect(leaks).toHaveLength(1)
    expect(leaks[0]!.severity).toBe('error')
    expect(leaks[0]!.message).toMatch(/tells the client|exists there/)
  })

  it('does not fire when the link is to `clientUrl`, or to any other address', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-internal-leak-safe-'))
    const doc = writeDoc(
      root,
      'docs/brief.md',
      `${FM('audience: client\n')}See [the client portal](https://client.example.com/brief.html) for detail.\n`,
    )
    const findings = checkDocs([doc], { internalUrl: 'https://internal.example.com' })
    expect(findings.filter((f) => f.rule === 'client-doc-links-internal')).toHaveLength(0)
  })

  it('does not fire on an internal document, even if it links to the internal site', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-internal-leak-internal-doc-'))
    const doc = writeDoc(
      root,
      'docs/brief.md',
      `${FM()}See [related work](https://internal.example.com/other.html) for detail.\n`,
    )
    const findings = checkDocs([doc], { internalUrl: 'https://internal.example.com' })
    expect(findings.filter((f) => f.rule === 'client-doc-links-internal')).toHaveLength(0)
  })

  it('never fires when no `internalUrl` is configured, regardless of what a client document links to', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-internal-leak-unconfigured-'))
    const doc = writeDoc(
      root,
      'docs/brief.md',
      `${FM('audience: client\n')}See [somewhere](https://internal.example.com/budget.html) for detail.\n`,
    )
    expect(checkDocs([doc]).filter((f) => f.rule === 'client-doc-links-internal')).toHaveLength(0)
  })

  it('`contrail check` fails the build end-to-end when a client document leaks the internal URL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-internal-leak-cli-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(
      join(root, 'contrail.config.ts'),
      "export default { plane: { baseUrl: 'https://plane.test', workspace: 'acme' }, repos: {}, " +
        "docs: ['./docs/**/*.md'], site: { host: 'vercel', internalUrl: 'https://internal.example.com' } }\n",
    )
    writeFileSync(
      join(root, 'docs', 'brief.md'),
      `${FM('audience: client\n')}See [the internal portal](https://internal.example.com/budget.html) for detail.\n`,
    )

    const { code, logs } = await runInWorkspace(root, ['check'])
    expect(code).toBe(1)
    expect(logs.some((l) => l.includes('client-doc-links-internal'))).toBe(true)
  })
})
