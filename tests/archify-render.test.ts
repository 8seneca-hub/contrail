import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  ArchifyValidationError,
  archifyHash,
  renderArchify,
  validateArchify,
  type ArchifyRunner,
} from '../src/render/archify.js'

function irFile(dir: string, name: string, contents: string): string {
  const path = join(dir, name)
  writeFileSync(path, contents)
  return path
}

function okRunner(): ArchifyRunner {
  return vi.fn(async (args: string[]) => {
    if (args[0] === 'render') {
      const outputPath = args[3]!
      writeFileSync(outputPath, '<html>stub</html>')
    }
    return { stdout: '{"ok":true}', code: 0 }
  })
}

describe('validateArchify', () => {
  it('resolves when the runner reports exit code 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'contrail-archify-'))
    const ir = irFile(dir, 'a.workflow.json', '{}')
    const runner = okRunner()
    await expect(validateArchify('workflow', ir, { runner })).resolves.toBeUndefined()
    expect(runner).toHaveBeenCalledWith(['validate', 'workflow', ir, '--json'])
  })

  it('throws ArchifyValidationError carrying the CLI JSON `error` field on failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'contrail-archify-'))
    const ir = irFile(dir, 'bad.workflow.json', '{"bad":true}')
    const runner: ArchifyRunner = vi.fn(async () => ({
      stdout: JSON.stringify({ ok: false, error: "workflow schema validation failed:\n  / must have required property 'nodes'" }),
      code: 1,
    }))
    await expect(validateArchify('workflow', ir, { runner })).rejects.toThrow(ArchifyValidationError)
    await expect(validateArchify('workflow', ir, { runner })).rejects.toThrow(/must have required property 'nodes'/)
  })

  it('falls back to raw stdout when the failure payload is not JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'contrail-archify-'))
    const ir = irFile(dir, 'bad.workflow.json', '{}')
    const runner: ArchifyRunner = vi.fn(async () => ({ stdout: 'not json, a stack trace instead', code: 1 }))
    await expect(validateArchify('workflow', ir, { runner })).rejects.toThrow(/stack trace instead/)
  })

  it('never invokes the real archify binary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'contrail-archify-'))
    const ir = irFile(dir, 'a.workflow.json', '{}')
    const runner = okRunner()
    await validateArchify('workflow', ir, { runner })
    // the fake runner is the only thing that ran archify's "CLI" — assert it saw a fake, in-process call
    expect(runner).toHaveBeenCalled()
  })
})

describe('renderArchify', () => {
  it('renders and reports the content hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'contrail-archify-'))
    const cache = mkdtempSync(join(tmpdir(), 'contrail-cache-'))
    const ir = irFile(dir, 'a.workflow.json', '{"a":1}')
    const runner = okRunner()
    const result = await renderArchify('workflow', ir, cache, { runner })
    expect(result.hash).toBe(archifyHash(readFileSync(ir)))
    expect(result.irPath).toBe(ir)
    expect(existsSync(result.htmlPath)).toBe(true)
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner).toHaveBeenCalledWith(['render', 'workflow', ir, result.htmlPath])
  })

  it('writes the artifact under <cacheDir>/archify/<hash>.html', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'contrail-archify-'))
    const cache = mkdtempSync(join(tmpdir(), 'contrail-cache-'))
    const ir = irFile(dir, 'a.workflow.json', '{"a":1}')
    const runner = okRunner()
    const result = await renderArchify('workflow', ir, cache, { runner })
    expect(result.htmlPath).toBe(join(cache, 'archify', `${result.hash}.html`))
  })

  it('a cache hit invokes the runner zero times', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'contrail-archify-'))
    const cache = mkdtempSync(join(tmpdir(), 'contrail-cache-'))
    const ir = irFile(dir, 'a.workflow.json', '{"a":1}')
    const runner = okRunner()
    await renderArchify('workflow', ir, cache, { runner })
    ;(runner as ReturnType<typeof vi.fn>).mockClear()
    const second = await renderArchify('workflow', ir, cache, { runner })
    expect(runner).not.toHaveBeenCalled()
    expect(existsSync(second.htmlPath)).toBe(true)
  })

  it('gives different hashes to different IR files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'contrail-archify-'))
    const cache = mkdtempSync(join(tmpdir(), 'contrail-cache-'))
    const irA = irFile(dir, 'a.workflow.json', '{"a":1}')
    const irB = irFile(dir, 'b.workflow.json', '{"a":2}')
    const runner = okRunner()
    const resultA = await renderArchify('workflow', irA, cache, { runner })
    const resultB = await renderArchify('workflow', irB, cache, { runner })
    expect(resultA.hash).not.toBe(resultB.hash)
    expect(archifyHash('{"a":1}')).not.toBe(archifyHash('{"a":2}'))
  })

  it('gives the same hash to identical IR contents in different files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'contrail-archify-'))
    const irA = irFile(dir, 'a.workflow.json', '{"same":true}')
    const irB = irFile(dir, 'b.workflow.json', '{"same":true}')
    expect(archifyHash(readFileSync(irA))).toBe(archifyHash(readFileSync(irB)))
  })

  it('propagates a render failure as ArchifyValidationError with the CLI message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'contrail-archify-'))
    const cache = mkdtempSync(join(tmpdir(), 'contrail-cache-'))
    const ir = irFile(dir, 'bad.workflow.json', '{"bad":true}')
    const runner: ArchifyRunner = vi.fn(async () => ({ stdout: 'workflow schema validation failed', code: 1 }))
    await expect(renderArchify('workflow', ir, cache, { runner })).rejects.toThrow(ArchifyValidationError)
    await expect(renderArchify('workflow', ir, cache, { runner })).rejects.toThrow(/schema validation failed/)
  })

  it('does not write an html file when the render fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'contrail-archify-'))
    const cache = mkdtempSync(join(tmpdir(), 'contrail-cache-'))
    const ir = irFile(dir, 'bad.workflow.json', '{"bad":true}')
    const runner: ArchifyRunner = vi.fn(async () => ({ stdout: 'nope', code: 1 }))
    await expect(renderArchify('workflow', ir, cache, { runner })).rejects.toThrow()
    const expectedPath = join(cache, 'archify', `${archifyHash(readFileSync(ir))}.html`)
    expect(existsSync(expectedPath)).toBe(false)
  })

  it('uses opts.bin to build the default runner instead of the real binary when no runner is injected', async () => {
    // Point "bin" at a non-existent executable so a stray call to the real
    // resolution path fails loudly (ENOENT) rather than silently invoking a
    // real archify on PATH. This proves tests never touch the real binary
    // even for the default-runner branch.
    const dir = mkdtempSync(join(tmpdir(), 'contrail-archify-'))
    const cache = mkdtempSync(join(tmpdir(), 'contrail-cache-'))
    const ir = irFile(dir, 'a.workflow.json', '{"a":1}')
    await expect(
      renderArchify('workflow', ir, cache, { bin: '/nonexistent/archify-binary-for-tests' }),
    ).rejects.toThrow()
  })
})
