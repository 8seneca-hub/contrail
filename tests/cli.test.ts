import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  archivedMessageFor,
  blockedMessageFor,
  exitCodeFor,
  findDocs,
  main,
  publishArgsFor,
  publishAndSave,
  resolveDocArg,
  runInit,
  sheetBlockedMessageFor,
  sheetStaleMessageFor,
  siteOutDirFor,
} from '../src/cli.js'
import { loadConfig } from '../src/config.js'
import { docsForAudience } from '../src/emit/site.js'
import { hashContent, loadLock } from '../src/lock.js'
import { parseDoc } from '../src/parse.js'
import type { PlaneApi } from '../src/plane/client.js'
import type { PublishResult } from '../src/plane/publish.js'
import type { Config, Lock } from '../src/types.js'

describe('runInit', () => {
  it('writes a config file that loads cleanly', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-init-'))
    const path = runInit(root)
    expect(existsSync(path)).toBe(true)
    expect(loadConfig(path).plane.workspace).toBeTypeOf('string')
  })

  it('refuses to overwrite an existing config', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-init-'))
    runInit(root)
    expect(() => runInit(root)).toThrow(/already exists/)
  })
})

describe('findDocs', () => {
  it('finds documents across several repositories in one workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-find-'))
    mkdirSync(join(root, 'repo-a', 'docs'), { recursive: true })
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'repo-a', 'docs', 'one.md'), '# one')
    writeFileSync(join(root, 'docs', 'two.md'), '# two')

    const found = findDocs({
      root,
      plane: { baseUrl: 'https://plane.test', workspace: 'acme' },
      repos: {},
      docs: ['./docs/**/*.md', './*/docs/**/*.md'],
    })

    expect(found.map((path) => path.split('/').pop()).sort()).toEqual(['one.md', 'two.md'])
  })

  it('returns absolute paths, sorted deterministically', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-find-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'zeta.md'), '# zeta')
    writeFileSync(join(root, 'docs', 'alpha.md'), '# alpha')

    const found = findDocs({
      root,
      plane: { baseUrl: 'https://plane.test', workspace: 'acme' },
      repos: {},
      docs: ['./docs/**/*.md'],
    })

    expect(found.every((path) => path.startsWith(root))).toBe(true)
    expect(found).toEqual([...found].sort())
    expect(found.map((path) => path.split('/').pop())).toEqual(['alpha.md', 'zeta.md'])
  })

  it('returns an empty array when a glob matches nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-find-'))
    mkdirSync(join(root, 'docs'), { recursive: true })

    const found = findDocs({
      root,
      plane: { baseUrl: 'https://plane.test', workspace: 'acme' },
      repos: {},
      docs: ['./docs/**/*.md', './nonexistent/**/*.md'],
    })

    expect(found).toEqual([])
  })
})

describe('--only filter', () => {
  it('selects the expected subset of documents by key substring', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-only-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(
      join(root, 'docs', 'auth.md'),
      '---\ntitle: Auth\nsummary: Auth docs\nstatus: current\n---\n# Auth',
    )
    writeFileSync(
      join(root, 'docs', 'billing.md'),
      '---\ntitle: Billing\nsummary: Billing docs\nstatus: current\n---\n# Billing',
    )

    const config = {
      root,
      plane: { baseUrl: 'https://plane.test', workspace: 'acme' },
      repos: {},
      docs: ['./docs/**/*.md'],
    }
    // Exercises the actual product code path (`publishArgsFor`, which itself
    // calls the exported `filterByOnly`) rather than a reimplementation of
    // the filter predicate, so it would fail if main()'s real filtering broke.
    const allDocs = findDocs(config).map((path) => parseDoc(path, config.root))
    const { docs } = publishArgsFor(allDocs, 'auth')

    expect(docs.map((doc) => doc.key)).toEqual(['docs/auth.md'])
  })

  it('never shrinks knownKeys, even when --only matches nothing', () => {
    // Regression test for the archive bug: `publishArgsFor` is the single
    // place the CLI assembles publishDocs' arguments, so this proves the
    // wiring itself (not just publishDocs in isolation) keeps `knownKeys`
    // as the FULL set while `docs` narrows to the --only match.
    const root = mkdtempSync(join(tmpdir(), 'contrail-only-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(
      join(root, 'docs', 'auth.md'),
      '---\ntitle: Auth\nsummary: Auth docs\nstatus: current\n---\n# Auth',
    )
    writeFileSync(
      join(root, 'docs', 'billing.md'),
      '---\ntitle: Billing\nsummary: Billing docs\nstatus: current\n---\n# Billing',
    )

    const config = {
      root,
      plane: { baseUrl: 'https://plane.test', workspace: 'acme' },
      repos: {},
      docs: ['./docs/**/*.md'],
    }
    const allDocs = findDocs(config).map((path) => parseDoc(path, config.root))

    const matching = publishArgsFor(allDocs, 'auth')
    expect(matching.docs.map((doc) => doc.key)).toEqual(['docs/auth.md'])
    expect(matching.knownKeys.sort()).toEqual(['docs/auth.md', 'docs/billing.md'])

    const noMatch = publishArgsFor(allDocs, 'nonexistent')
    expect(noMatch.docs).toEqual([])
    expect(noMatch.knownKeys.sort()).toEqual(['docs/auth.md', 'docs/billing.md'])
  })
})

describe('blockedMessageFor', () => {
  it('names the document and warns that --force discards the edit', () => {
    const lines = blockedMessageFor('docs/settlement.md')
    expect(lines.some((line) => line.includes('docs/settlement.md'))).toBe(true)
    expect(lines.some((line) => /force/i.test(line) && /discard/i.test(line))).toBe(true)
  })
})

describe('sheetStaleMessageFor', () => {
  it('names the range and says why numbers might be old', () => {
    const line = sheetStaleMessageFor('sheet-1::Estimate!A1:B2')
    expect(line).toContain('sheet-1::Estimate!A1:B2')
    expect(line).toMatch(/STALE/)
    expect(line).toMatch(/cached/i)
  })
})

describe('sheetBlockedMessageFor', () => {
  it('names the range and warns that --force discards the edit', () => {
    const lines = sheetBlockedMessageFor('sheet-1::Estimate!A1:B2')
    expect(lines.some((line) => line.includes('sheet-1::Estimate!A1:B2'))).toBe(true)
    expect(lines.some((line) => /force/i.test(line) && /discard/i.test(line))).toBe(true)
  })
})

describe('resolveDocArg', () => {
  it('finds a document by its absolute path, and returns undefined for no match', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-resolve-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(
      join(root, 'docs', 'estimate.md'),
      '---\ntitle: T\nsummary: S\nstatus: current\n---\nBody.\n',
    )
    const doc = parseDoc(join(root, 'docs', 'estimate.md'), root)

    // Absolute paths bypass any cwd-vs-realpath symlink mismatch (macOS resolves `/var` to
    // `/private/var` in `process.cwd()`), so this exercises `resolveDocArg`'s own match logic
    // directly rather than that platform quirk.
    expect(resolveDocArg([doc], doc.absPath)).toBe(doc)
    expect(resolveDocArg([doc], join(root, 'docs', 'nonexistent.md'))).toBeUndefined()
  })

  it('resolves a relative path against the current working directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-resolve-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(
      join(root, 'docs', 'estimate.md'),
      '---\ntitle: T\nsummary: S\nstatus: current\n---\nBody.\n',
    )
    // Parsed the same way `main()` does: relative to `process.cwd()` after chdir, so `doc.absPath`
    // and `resolveDocArg`'s own `resolve(process.cwd(), docArg)` agree on the same (possibly
    // symlink-resolved) root.
    const cwd = process.cwd()
    process.chdir(root)
    try {
      const doc = parseDoc(resolve(process.cwd(), 'docs/estimate.md'), process.cwd())
      expect(resolveDocArg([doc], 'docs/estimate.md')).toBe(doc)
      expect(resolveDocArg([doc], 'docs/nonexistent.md')).toBeUndefined()
    } finally {
      process.chdir(cwd)
    }
  })
})

describe('exitCodeFor', () => {
  const base: PublishResult = { created: [], updated: [], skipped: [], blocked: [], archived: [] }

  it('is zero when nothing was blocked', () => {
    expect(exitCodeFor({ ...base, created: ['docs/a.md'] })).toBe(0)
  })

  it('is non-zero when anything was blocked', () => {
    expect(exitCodeFor({ ...base, blocked: ['docs/a.md'] })).toBe(1)
  })
})

describe('archivedMessageFor', () => {
  it('names the document as archived on a real run', () => {
    expect(archivedMessageFor('docs/gone.md', false)).toContain('docs/gone.md')
    expect(archivedMessageFor('docs/gone.md', false)).toMatch(/^ARCHIVED/)
  })

  it('makes clear a dry run has not archived anything yet', () => {
    const line = archivedMessageFor('docs/gone.md', true)
    expect(line).toContain('docs/gone.md')
    expect(line).toMatch(/WOULD ARCHIVE/)
  })
})

describe('publishAndSave', () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'contrail-publish-save-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(
      join(root, 'docs', 'doc.md'),
      '---\ntitle: T\nsummary: S\nstatus: current\n---\n\n```mermaid\ngraph TD; A-->B;\n```\n',
    )
    const config: Config = {
      root,
      plane: { baseUrl: 'https://plane.test', workspace: 'acme' },
      repos: {},
      docs: ['./docs/**/*.md'],
    }
    const doc = parseDoc(join(root, 'docs', 'doc.md'), root)
    return { root, config, doc }
  }

  function crashingClient(): PlaneApi {
    const pages = new Map<string, string>()
    let nextPageId = 1
    return {
      createPage: async (input) => {
        const id = `page-${nextPageId++}`
        pages.set(id, input.description_html)
        return { id, parentLinkPending: false }
      },
      getPage: async (pageId) => ({
        id: pageId,
        name: 'T',
        description_html: pages.get(pageId) ?? '',
        updated_at: '',
      }),
      updatePage: async () => {
        throw new Error('should not reach updatePage')
      },
      archivePage: async () => {},
      // Crash after the provisional lock entry (written right after
      // createPage) is already in place, mirroring a real mmdc failure or a
      // dropped connection mid-upload.
      createAssetUpload: async () => {
        throw new Error('network blip during asset upload')
      },
      uploadAssetBytes: async () => {},
      confirmAttachment: async () => {},
    }
  }

  const mmdc = vi.fn(async (_input: string, output: string) => writeFileSync(output, 'stub-png-bytes'))

  it('saves the lock with the provisional entry when publishDocs throws mid-publish, then rethrows', async () => {
    const { root, config, doc } = setup()
    const client = crashingClient()
    const lock: Lock = { version: 1, docs: {} }

    await expect(
      publishAndSave({
        config,
        docs: [doc],
        client,
        lock,
        cacheDir: join(root, '.cache'),
        knownKeys: [doc.key],
        options: { mmdc },
      }),
    ).rejects.toThrow(/network blip/)

    // Exercise the real save path: read the lock back from disk, not the
    // in-memory object `publishDocs` mutated.
    const saved = loadLock(root)
    const entry = saved.docs[doc.key]
    expect(entry).toBeDefined()
    expect(entry?.contentHash).toBe('')

    // The provisional remoteHash must match what Plane is actually holding
    // right now, or a retry's overwrite guard would block instead of recover.
    const remote = await client.getPage(entry!.pageId)
    expect(hashContent([remote.description_html])).toBe(entry!.remoteHash)
  })

  it('does not save the lock on a dry run', async () => {
    // A dry run returns before any client call (createAssetUpload's throw in
    // `crashingClient` is unreachable here), so this exercises the OTHER half
    // of the `finally`: it must stay a no-op on the dry-run path, matching
    // main()'s prior `if (!values['dry-run']) saveLock(...)` behavior exactly.
    const { root, config, doc } = setup()
    const client = crashingClient()
    const lock: Lock = { version: 1, docs: {} }

    const result = await publishAndSave({
      config,
      docs: [doc],
      client,
      lock,
      cacheDir: join(root, '.cache'),
      knownKeys: [doc.key],
      options: { dryRun: true, mmdc },
    })

    expect(result.created).toEqual([doc.key])
    expect(existsSync(join(root, 'contrail.lock.json'))).toBe(false)
  })
})

describe('publish --audience (Fix 4: publish was ignoring the audience filter)', () => {
  function fakeSuccessClient(): PlaneApi & { created: string[] } {
    const created: string[] = []
    let nextPageId = 1
    return {
      created,
      createPage: async (input) => {
        created.push(input.name)
        return { id: `page-${nextPageId++}`, parentLinkPending: false }
      },
      getPage: async (pageId) => ({ id: pageId, name: '', description_html: '', updated_at: '' }),
      updatePage: async () => {},
      archivePage: async () => {},
      createAssetUpload: async () => ({ asset_id: 'asset-1', upload_data: { url: 'https://s3.test', fields: {} } }),
      uploadAssetBytes: async () => {},
      confirmAttachment: async () => {},
    }
  }

  it('a mixed tree publishes only the client documents; knownKeys (the archive sweep) still covers everything', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-publish-audience-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(
      join(root, 'docs', 'client.md'),
      '---\ntitle: Client Doc\nsummary: S\nstatus: current\naudience: client\n---\n\nBody.\n',
    )
    writeFileSync(
      join(root, 'docs', 'internal.md'),
      '---\ntitle: Internal Doc\nsummary: S\nstatus: current\naudience: internal\n---\n\nBody.\n',
    )
    const config: Config = {
      root,
      plane: { baseUrl: 'https://plane.test', workspace: 'acme' },
      repos: {},
      docs: ['./docs/**/*.md'],
    }
    const allDocs = [
      parseDoc(join(root, 'docs', 'client.md'), root),
      parseDoc(join(root, 'docs', 'internal.md'), root),
    ]
    const { docs, knownKeys } = publishArgsFor(allDocs, undefined)

    // The exact composition main() now does for `publish --audience client`.
    const eligible = docsForAudience(docs, 'client')
    expect(eligible.map((d) => d.key)).toEqual(['docs/client.md'])

    const client = fakeSuccessClient()
    const lock: Lock = { version: 1, docs: {} }
    const result = await publishAndSave({
      config,
      docs: eligible,
      client,
      lock,
      cacheDir: join(root, '.cache'),
      knownKeys,
      options: {},
    })

    expect(result.created).toEqual(['docs/client.md'])
    expect(client.created).toEqual(['Client Doc'])
    // Never hit the network — `fakeSuccessClient` never opens a socket.
    // `knownKeys` (the archive sweep) is unaffected by the audience filter —
    // only which documents are ELIGIBLE to publish narrows.
    expect(knownKeys).toEqual(['docs/client.md', 'docs/internal.md'])
  })

  it('omitting --audience keeps the default: every document is eligible, matching prior behavior', () => {
    const client = parseDocFixture('client', 'client')
    const internal = parseDocFixture('internal', 'internal')
    expect(docsForAudience([client, internal], undefined)).toEqual([client, internal])
  })

  function parseDocFixture(name: string, audience: 'client' | 'internal') {
    const root = mkdtempSync(join(tmpdir(), 'contrail-publish-audience-default-'))
    writeFileSync(
      join(root, `${name}.md`),
      `---\ntitle: T\nsummary: S\nstatus: current\naudience: ${audience}\n---\n\nBody.\n`,
    )
    return parseDoc(join(root, `${name}.md`), root)
  }
})

describe('siteOutDirFor', () => {
  const config: Config = {
    root: '/workspace',
    plane: { baseUrl: 'https://plane.test', workspace: 'acme' },
    repos: {},
    docs: ['./docs/**/*.md'],
  }

  it('defaults to <config.root>/site when --out is omitted', () => {
    expect(siteOutDirFor(config, undefined)).toBe('/workspace/site')
  })

  it('resolves a relative --out against config.root', () => {
    expect(siteOutDirFor(config, './public')).toBe('/workspace/public')
  })

  it('leaves an absolute --out untouched', () => {
    expect(siteOutDirFor(config, '/tmp/out')).toBe('/tmp/out')
  })
})

describe('site command (via main)', () => {
  it('builds a site with an index page and one page per document', async () => {
    // No mermaid/artifact/archify blocks in this doc, so nothing here can
    // reach a real subprocess — safe to run straight through main().
    const root = mkdtempSync(join(tmpdir(), 'contrail-site-cli-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(
      join(root, 'docs', 'plain.md'),
      '---\ntitle: Plain\nsummary: Plain docs\nstatus: current\n---\n\nJust prose, no diagrams.\n',
    )
    writeFileSync(
      join(root, 'contrail.config.ts'),
      "export default { plane: { baseUrl: 'https://plane.test', workspace: 'acme' }, repos: {}, " +
        "docs: ['./docs/**/*.md'] }\n",
    )

    const cwd = process.cwd()
    process.chdir(root)
    try {
      expect(await main(['site', '--out', './site'])).toBe(0)
    } finally {
      process.chdir(cwd)
    }

    expect(existsSync(join(root, 'site', 'index.html'))).toBe(true)
    // The site mirrors the source tree (docs/ dropped) rather than
    // flattening it with `__`.
    expect(existsSync(join(root, 'site', 'plain.html'))).toBe(true)
    expect(existsSync(join(root, 'site', 'site.css'))).toBe(true)
    expect(readFileSync(join(root, 'site', 'index.html'), 'utf8')).toContain('Plain')
  })

  it('help text lists the site command and its --out flag', () => {
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(msg)
    })
    return main(['help']).then((code) => {
      spy.mockRestore()
      expect(code).toBe(0)
      expect(logs.join('\n')).toContain('site [--out <dir>]')
    })
  })

  it('help text lists the check command', () => {
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(msg)
    })
    return main(['help']).then((code) => {
      spy.mockRestore()
      expect(code).toBe(0)
      expect(logs.join('\n')).toContain('check [--strict] [--index]')
    })
  })
})

describe('check command (via main)', () => {
  function setupWorkspace() {
    const root = mkdtempSync(join(tmpdir(), 'contrail-check-cli-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(
      join(root, 'contrail.config.ts'),
      "export default { plane: { baseUrl: 'https://plane.test', workspace: 'acme' }, repos: {}, " +
        "docs: ['./docs/**/*.md'] }\n",
    )
    return root
  }

  it('exits 0 on a clean workspace and reports "clean"', async () => {
    const root = setupWorkspace()
    writeFileSync(
      join(root, 'docs', 'clean.md'),
      '---\ntitle: Clean\nsummary: A clean doc.\nstatus: current\n---\n\nShort prose, nothing to flag.\n',
    )

    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg))
    const cwd = process.cwd()
    process.chdir(root)
    let code: number
    try {
      code = await main(['check'])
    } finally {
      process.chdir(cwd)
      spy.mockRestore()
    }

    expect(code).toBe(0)
    expect(logs.join('\n')).toContain('clean')
  })

  it('exits 0 on warnings without --strict, and 1 with --strict', async () => {
    const root = setupWorkspace()
    writeFileSync(
      join(root, 'docs', 'stale.md'),
      '---\ntitle: Stale\nsummary: A stale doc.\nstatus: stale\n---\n\nBody.\n',
    )

    const cwd = process.cwd()
    process.chdir(root)
    try {
      expect(await main(['check'])).toBe(0)
      expect(await main(['check', '--strict'])).toBe(1)
    } finally {
      process.chdir(cwd)
    }
  })

  it('exits 1 for a missing-summary error even without --strict', async () => {
    const root = setupWorkspace()
    writeFileSync(
      join(root, 'docs', 'bad.md'),
      '---\ntitle: Bad\nsummary: A bad doc.\nstatus: current\n---\n\n```archify {type=workflow, src=./a.json}\n```\n',
    )

    const cwd = process.cwd()
    process.chdir(root)
    try {
      expect(await main(['check'])).toBe(1)
    } finally {
      process.chdir(cwd)
    }
  })

  it('--index writes docs/llms.txt grouped by kind', async () => {
    const root = setupWorkspace()
    writeFileSync(
      join(root, 'docs', 'a.md'),
      '---\ntitle: A\nsummary: Doc A.\nstatus: current\nkind: reference\n---\n\nBody.\n',
    )

    const cwd = process.cwd()
    process.chdir(root)
    try {
      expect(await main(['check', '--index'])).toBe(0)
    } finally {
      process.chdir(cwd)
    }

    const llmsTxt = readFileSync(join(root, 'docs', 'llms.txt'), 'utf8')
    expect(llmsTxt).toContain('## Reference')
    expect(llmsTxt).toContain('[A]')
  })

  it('--json emits a machine-readable findings array instead of formatted lines', async () => {
    const root = setupWorkspace()
    writeFileSync(
      join(root, 'docs', 'stale.md'),
      '---\ntitle: Stale\nsummary: A stale doc.\nstatus: stale\n---\n\nBody.\n',
    )

    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg))
    const cwd = process.cwd()
    process.chdir(root)
    let code: number
    try {
      code = await main(['check', '--json'])
    } finally {
      process.chdir(cwd)
      spy.mockRestore()
    }

    expect(code).toBe(0)
    expect(logs).toHaveLength(1)
    const parsed = JSON.parse(logs[0]!)
    expect(parsed.errors).toBe(0)
    expect(parsed.warnings).toBeGreaterThan(0)
    expect(parsed.findings.some((f: { rule: string }) => f.rule === 'stale-doc')).toBe(true)
    expect(parsed.indexPath).toBeNull()
  })
})

describe('status command (via main)', () => {
  function setupWorkspace() {
    const root = mkdtempSync(join(tmpdir(), 'contrail-status-cli-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(
      join(root, 'contrail.config.ts'),
      "export default { plane: { baseUrl: 'https://plane.test', workspace: 'acme' }, repos: {}, " +
        "docs: ['./docs/**/*.md'] }\n",
    )
    return root
  }

  it('reports pageId, status, and health flags per document in human form', async () => {
    const root = setupWorkspace()
    writeFileSync(
      join(root, 'docs', 'a.md'),
      '---\ntitle: A\nsummary: Doc A.\nstatus: current\n---\n\nBody.\n',
    )

    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg))
    const cwd = process.cwd()
    process.chdir(root)
    try {
      expect(await main(['status'])).toBe(0)
    } finally {
      process.chdir(cwd)
      spy.mockRestore()
    }

    const output = logs.join('\n')
    expect(output).toContain('unpublished')
    expect(output).toContain('docs/a.md')
    expect(output).toContain('no-owner')
    expect(output).toContain('Documentation health:')
  })

  it('--json emits the same documentation view as structured data', async () => {
    const root = setupWorkspace()
    writeFileSync(
      join(root, 'docs', 'a.md'),
      '---\ntitle: A\nsummary: Doc A.\nstatus: current\n---\n\nBody.\n',
    )

    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg))
    const cwd = process.cwd()
    process.chdir(root)
    try {
      expect(await main(['status', '--json'])).toBe(0)
    } finally {
      process.chdir(cwd)
      spy.mockRestore()
    }

    expect(logs).toHaveLength(1)
    const parsed = JSON.parse(logs[0]!)
    expect(parsed.docs).toHaveLength(1)
    expect(parsed.docs[0].key).toBe('docs/a.md')
    expect(parsed.docs[0].noOwner).toBe(true)
    expect(parsed.summary.noOwner).toBe(1)
  })
})

describe('scaffold command --json (via main)', () => {
  it('emits {"created": <path>} on success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-scaffold-json-'))
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg))
    const cwd = process.cwd()
    process.chdir(root)
    let code: number
    try {
      code = await main(['scaffold', 'adr', 'docs/decisions/001-use-postgres.md', '--json'])
    } finally {
      process.chdir(cwd)
      spy.mockRestore()
    }

    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0]!)
    expect(parsed.created).toMatch(/docs\/decisions\/001-use-postgres\.md$/)
    expect(existsSync(parsed.created)).toBe(true)
  })

  it('emits {"error": <message>} and a non-zero exit on a bad docKind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-scaffold-json-'))
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg))
    const cwd = process.cwd()
    process.chdir(root)
    let code: number
    try {
      code = await main(['scaffold', 'not-a-kind', 'docs/x.md', '--json'])
    } finally {
      process.chdir(cwd)
      spy.mockRestore()
    }

    expect(code).toBe(1)
    const parsed = JSON.parse(logs[0]!)
    expect(parsed.error).toMatch(/not-a-kind/)
  })
})

describe('sheet command (via main)', () => {
  function setupWorkspace() {
    const root = mkdtempSync(join(tmpdir(), 'contrail-sheet-cli-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(
      join(root, 'contrail.config.ts'),
      "export default { plane: { baseUrl: 'https://plane.test', workspace: 'acme' }, repos: {}, " +
        "docs: ['./docs/**/*.md'] }\n",
    )
    writeFileSync(
      join(root, 'docs', 'estimate.md'),
      '---\ntitle: Estimate\nsummary: S\nstatus: current\n---\n\n' +
        '```sheet {id=sheet-1, range="A1:B2", summary="Effort estimate."}\n```\n',
    )
    return root
  }

  it('prints usage and exits 2 with no action', async () => {
    const root = setupWorkspace()
    const cwd = process.cwd()
    process.chdir(root)
    try {
      expect(await main(['sheet'])).toBe(2)
    } finally {
      process.chdir(cwd)
    }
  })

  it('prints usage and exits 2 for an unknown action', async () => {
    const root = setupWorkspace()
    const cwd = process.cwd()
    process.chdir(root)
    try {
      expect(await main(['sheet', 'bogus', 'docs/estimate.md'])).toBe(2)
    } finally {
      process.chdir(cwd)
    }
  })

  it('prints usage and exits 2 when the doc argument is missing', async () => {
    const root = setupWorkspace()
    const cwd = process.cwd()
    process.chdir(root)
    try {
      expect(await main(['sheet', 'pull'])).toBe(2)
    } finally {
      process.chdir(cwd)
    }
  })

  it('exits 2 naming the argument when no document matches it', async () => {
    const root = setupWorkspace()
    const logs: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((msg: string) => logs.push(msg))
    const cwd = process.cwd()
    process.chdir(root)
    try {
      expect(await main(['sheet', 'pull', 'docs/nonexistent.md'])).toBe(2)
    } finally {
      process.chdir(cwd)
      spy.mockRestore()
    }
    expect(logs.join('\n')).toContain('docs/nonexistent.md')
  })

  it('rejects with an actionable, credential-naming error before ever touching the network', async () => {
    const root = setupWorkspace()
    const original = process.env.GOOGLE_APPLICATION_CREDENTIALS
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS
    const cwd = process.cwd()
    process.chdir(root)
    try {
      await expect(main(['sheet', 'pull', 'docs/estimate.md'])).rejects.toThrow(/GOOGLE_APPLICATION_CREDENTIALS/)
    } finally {
      process.chdir(cwd)
      if (original !== undefined) process.env.GOOGLE_APPLICATION_CREDENTIALS = original
    }
  })

  it('help text lists the sheet command', async () => {
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg))
    const code = await main(['help'])
    spy.mockRestore()
    expect(code).toBe(0)
    expect(logs.join('\n')).toContain('sheet pull <doc>')
    expect(logs.join('\n')).toContain('sheet push <doc>')
  })
})
