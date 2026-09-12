import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RenderedDiagram } from '../types.js'

export type Mmdc = (inputFile: string, outputFile: string) => Promise<void>

export function diagramHash(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16)
}

const spawnMmdc: Mmdc = (inputFile, outputFile) =>
  new Promise((resolve, reject) => {
    const child = spawn('npx', ['mmdc', '-i', inputFile, '-o', outputFile, '-b', 'transparent'], {
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
