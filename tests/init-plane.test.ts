import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolvePlaneTarget } from '../src/cli.js'
import { PlaneApiError, type CreateProjectInput, type PlaneProjectApi } from '../src/plane/client.js'
import { deriveIdentifier, renderConfig, runInitTemplate } from '../src/scaffold.js'

function fakeProjectApi(overrides: Partial<PlaneProjectApi> = {}) {
  const created: CreateProjectInput[] = []
  const api: PlaneProjectApi & { created: CreateProjectInput[] } = {
    created,
    createProject: async (input) => {
      created.push(input)
      return { id: 'proj-1', name: input.name, identifier: input.identifier, docs_view: true }
    },
    ...overrides,
  }
  return api
}

describe('deriveIdentifier', () => {
  it('takes the alphanumerics, uppercased, within Plane\'s 12-character column', () => {
    expect(deriveIdentifier('Hope Helpline')).toBe('HOPEHELPLINE')
    expect(deriveIdentifier('a-very-long-project-name-indeed')).toHaveLength(12)
  })

  it('returns undefined when the name holds nothing usable, rather than inventing one', () => {
    expect(deriveIdentifier('— ✳ —')).toBeUndefined()
  })
})

describe('resolvePlaneTarget', () => {
  const originalKey = process.env.PLANE_API_KEY

  beforeEach(() => {
    process.env.PLANE_API_KEY = 'test-key'
  })
  afterEach(() => {
    if (originalKey === undefined) delete process.env.PLANE_API_KEY
    else process.env.PLANE_API_KEY = originalKey
  })

  it('creates the project with the Docs tab already enabled', async () => {
    const api = fakeProjectApi()
    const target = await resolvePlaneTarget(
      { baseUrl: 'https://plane.test', workspace: 'acme', name: 'Hope Helpline' },
      () => api,
    )

    expect(target).toEqual({ baseUrl: 'https://plane.test', workspace: 'acme', projectId: 'proj-1' })
    expect(api.created).toEqual([{ name: 'Hope Helpline', identifier: 'HOPEHELPLINE' }])
  })

  it('trims a trailing slash off the base url so the printed docs URL has no double slash', async () => {
    const target = await resolvePlaneTarget(
      { baseUrl: 'https://plane.test/', workspace: 'acme', name: 'Demo' },
      () => fakeProjectApi(),
    )
    expect(target.baseUrl).toBe('https://plane.test')
  })

  it('attaches to an existing project without creating one', async () => {
    const api = fakeProjectApi()
    const target = await resolvePlaneTarget(
      { baseUrl: 'https://plane.test', workspace: 'acme', name: 'Demo', projectId: 'existing-9' },
      () => api,
    )

    expect(target.projectId).toBe('existing-9')
    expect(api.created).toEqual([])
  })

  it('requires the workspace alongside the url, rather than writing a config that looks wired', async () => {
    await expect(
      resolvePlaneTarget({ baseUrl: 'https://plane.test', name: 'Demo' }, () => fakeProjectApi()),
    ).rejects.toThrow('--plane-url and --workspace must be given together.')
  })

  it('asks for an identifier when the name yields none', async () => {
    await expect(
      resolvePlaneTarget({ baseUrl: 'https://plane.test', workspace: 'acme', name: '—' }, () => fakeProjectApi()),
    ).rejects.toThrow('Pass --identifier.')
  })

  it('refuses without an API key, and never reads one from a config file', async () => {
    delete process.env.PLANE_API_KEY
    await expect(
      resolvePlaneTarget({ baseUrl: 'https://plane.test', workspace: 'acme', name: 'Demo' }, () => fakeProjectApi()),
    ).rejects.toThrow('PLANE_API_KEY is not set')
  })

  it('turns a duplicate identifier into advice, not a raw 409', async () => {
    const api = fakeProjectApi({
      createProject: async () => {
        throw new PlaneApiError('Plane POST /projects/ failed with 409', 409, '{}')
      },
    })

    await expect(
      resolvePlaneTarget({ baseUrl: 'https://plane.test', workspace: 'acme', name: 'Demo' }, () => api),
    ).rejects.toThrow(/--project-id to write docs into the existing project/)
  })
})

describe('renderConfig', () => {
  it('writes a config that deploy can use unchanged, and no API key', () => {
    const config = renderConfig({ baseUrl: 'https://plane.test', workspace: 'acme', projectId: 'proj-1' })

    expect(config).toContain("baseUrl: 'https://plane.test'")
    expect(config).toContain("workspace: 'acme'")
    expect(config).toContain("target: 'plane'")
    expect(config).toContain("projectId: 'proj-1'")
    expect(config).not.toMatch(/apiKey|PLANE_API_KEY/)
  })

  it('falls back to the placeholder config when init was not pointed at Plane', () => {
    expect(renderConfig()).toContain('plane.example.com')
  })
})

describe('runInitTemplate with a Plane target', () => {
  it('scaffolds a tree whose config is already wired to the project', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'contrail-init-'))
    const result = runInitTemplate(cwd, {
      project: 'Hope Helpline',
      plane: { baseUrl: 'https://plane.test', workspace: 'acme', projectId: 'proj-1' },
    })

    expect(result.created).toContain('contrail.config.ts')
    expect(readFileSync(join(cwd, 'contrail.config.ts'), 'utf8')).toContain("projectId: 'proj-1'")
    expect(readFileSync(join(cwd, 'docs/00-meta/project.yml'), 'utf8')).toContain('Hope Helpline')
  })
})
