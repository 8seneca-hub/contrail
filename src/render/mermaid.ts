import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { RenderedDiagram } from '../types.js'

export type Mmdc = (inputFile: string, outputFile: string) => Promise<void>

export function diagramHash(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16)
}

let cachedMmdcScript: string | undefined

/** Absolute path to mermaid-cli's `mmdc` entry point, resolved from contrail's own install.
 *
 * Not `npx mmdc`: npx resolves from the *current working directory*, and a
 * `contrail init` project has no `node_modules` of its own - so on a fresh
 * install every document carrying a diagram died with "could not determine
 * executable to run". mermaid-cli is contrail's dependency, so the copy that
 * matters is the one next to this file, wherever contrail happens to be
 * installed.
 */
export function mmdcScript(): string {
  if (cachedMmdcScript !== undefined) return cachedMmdcScript

  const require = createRequire(import.meta.url)
  let entry: string
  try {
    entry = require.resolve('@mermaid-js/mermaid-cli')
  } catch (cause) {
    throw new Error(
      'Cannot find @mermaid-js/mermaid-cli, which contrail depends on to render diagrams. ' +
        "Reinstall contrail's dependencies.",
      { cause },
    )
  }

  // mermaid-cli's `exports` map does not expose its own package.json, so the
  // manifest has to be found by walking up from the resolved entry point.
  let packageDir = dirname(entry)
  while (!existsSync(join(packageDir, 'package.json'))) {
    const parent = dirname(packageDir)
    if (parent === packageDir) {
      throw new Error(`Resolved @mermaid-js/mermaid-cli to ${entry} but found no package.json above it.`)
    }
    packageDir = parent
  }

  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    bin?: string | Record<string, string>
  }
  const binPath = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.mmdc
  if (!binPath) {
    throw new Error(`@mermaid-js/mermaid-cli at ${packageDir} declares no mmdc binary.`)
  }

  cachedMmdcScript = join(packageDir, binPath)
  return cachedMmdcScript
}

const spawnMmdc: Mmdc = (inputFile, outputFile) =>
  new Promise((resolve, reject) => {
    // `process.execPath` rather than the shebang: the resolved path is a script
    // in node_modules, which is not guaranteed to be executable.
    const child = spawn(process.execPath, [mmdcScript(), '-i', inputFile, '-o', outputFile, '-b', 'transparent'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`mmdc exited with code ${code}: ${stderr.trim()}`))
    })
  })

export async function renderMermaid(
  source: string,
  cacheDir: string,
  mmdc: Mmdc = spawnMmdc,
): Promise<RenderedDiagram> {
  const hash = diagramHash(source)
  const dir = join(cacheDir, 'mermaid')
  mkdirSync(dir, { recursive: true })

  const pngPath = join(dir, `${hash}.png`)
  const svgPath = join(dir, `${hash}.svg`)
  if (existsSync(pngPath) && existsSync(svgPath)) return { hash, pngPath, svgPath }

  const inputFile = join(dir, `${hash}.mmd`)
  writeFileSync(inputFile, source)
  if (!existsSync(pngPath)) await mmdc(inputFile, pngPath)
  if (!existsSync(svgPath)) await mmdc(inputFile, svgPath)
  return { hash, pngPath, svgPath }
}
