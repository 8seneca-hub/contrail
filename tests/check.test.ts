import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildLlmsTxt, checkDocs, checkExitCode, llmsTxtPath, writeLlmsTxt } from '../src/check.js'
import { parseDoc } from '../src/parse.js'
import type { Config, Doc } from '../src/types.js'

function doc(contents: string, name = 'doc.md'): Doc {
  const root = mkdtempSync(join(tmpdir(), 'contrail-check-'))
  writeFileSync(join(root, name), contents)
  return parseDoc(join(root, name), root)
}

function findingsFor(rule: string, findings: ReturnType<typeof checkDocs>) {
  return findings.filter((f) => f.rule === rule)
}

const FM = (extra = '') => `---
title: T
summary: S
status: current
${extra}---

`

describe('flow-without-diagram', () => {
  it('fires on a flow heading with no diagram in its section', () => {
    const d = doc(`${FM()}## Review flow

Some prose about the review flow, step by step, with no picture at all.
`)
    const findings = findingsFor('flow-without-diagram', checkDocs([d]))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toContain("Section 'Review flow'")
    expect(findings[0]!.message).toContain('archify')
    expect(findings[0]!.severity).toBe('warn')
  })

  it('stays silent when the section has a diagram', () => {
    const d = doc(`${FM()}## Review flow

\`\`\`archify {type=workflow, src=./a.json, summary="The review flow."}
\`\`\`
`)
    expect(findingsFor('flow-without-diagram', checkDocs([d]))).toHaveLength(0)
  })

  it('counts a diagram nested under a sub-heading as covering the parent section', () => {
    const d = doc(`${FM()}## Deployment pipeline

### Stage one

\`\`\`archify {type=architecture, src=./a.json, summary="The pipeline stages."}
\`\`\`

### Stage two

More prose.
`)
    expect(findingsFor('flow-without-diagram', checkDocs([d]))).toHaveLength(0)
  })

  it('stays silent on a heading that does not match the flow vocabulary', () => {
    const d = doc(`${FM()}## What each reader gets

Plain descriptive prose, nothing flow-shaped about this heading.
`)
    expect(findingsFor('flow-without-diagram', checkDocs([d]))).toHaveLength(0)
  })

  it('suggests lifecycle for a lifecycle/state heading', () => {
    const d = doc(`${FM()}## Order lifecycle

Prose describing the states an order moves through.
`)
    const findings = findingsFor('flow-without-diagram', checkDocs([d]))
    expect(findings[0]!.message).toContain('type=lifecycle')
  })
})

describe('steps-without-diagram', () => {
  it('fires on an ordered list of four or more items with no diagram in its section', () => {
    const d = doc(`${FM()}## Setup

1. First
2. Second
3. Third
4. Fourth
`)
    const findings = findingsFor('steps-without-diagram', checkDocs([d]))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toContain("Section 'Setup'")
    expect(findings[0]!.message).toContain('4 ordered steps')
  })

  it('stays silent below the four-item threshold', () => {
    const d = doc(`${FM()}## Setup

1. First
2. Second
3. Third
`)
    expect(findingsFor('steps-without-diagram', checkDocs([d]))).toHaveLength(0)
  })

  it('stays silent when the section has a diagram', () => {
    const d = doc(`${FM()}## Setup

\`\`\`archify {type=workflow, src=./a.json, summary="Setup steps."}
\`\`\`

1. First
2. Second
3. Third
4. Fourth
`)
    expect(findingsFor('steps-without-diagram', checkDocs([d]))).toHaveLength(0)
  })
})

describe('undiagrammed-doc', () => {
  it('fires on a document over 400 words with no diagram at all', () => {
    const longBody = Array.from({ length: 420 }, (_, i) => `word${i}`).join(' ')
    const d = doc(`${FM()}${longBody}\n`)
    expect(findingsFor('undiagrammed-doc', checkDocs([d]))).toHaveLength(1)
  })

  it('stays silent under the word threshold', () => {
    const d = doc(`${FM()}Just a short paragraph.\n`)
    expect(findingsFor('undiagrammed-doc', checkDocs([d]))).toHaveLength(0)
  })

  it('stays silent when a diagram exists, regardless of length', () => {
    const longBody = Array.from({ length: 420 }, (_, i) => `word${i}`).join(' ')
    const d = doc(`${FM()}${longBody}

\`\`\`archify {type=architecture, src=./a.json, summary="The shape of it."}
\`\`\`
`)
    expect(findingsFor('undiagrammed-doc', checkDocs([d]))).toHaveLength(0)
  })
})

describe('missing-summary', () => {
  it('reports a missing summary as an error, distinct from the warn rules', () => {
    const d = doc(`${FM()}\`\`\`archify {type=workflow, src=./a.json}
\`\`\`
`)
    const findings = findingsFor('missing-summary', checkDocs([d]))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('error')
    expect(findings[0]!.message).toContain('summary')
  })

  it('stays silent when the summary is present', () => {
    const d = doc(`${FM()}\`\`\`archify {type=workflow, src=./a.json, summary="A summary."}
\`\`\`
`)
    expect(findingsFor('missing-summary', checkDocs([d]))).toHaveLength(0)
  })
})

describe('stale-doc', () => {
  it('fires when status is stale', () => {
    const d = doc(`---
title: T
summary: S
status: stale
---

Body.
`)
    expect(findingsFor('stale-doc', checkDocs([d]))).toHaveLength(1)
  })

  it('stays silent for every other status', () => {
    for (const status of ['draft', 'review', 'current']) {
      const d = doc(`---
title: T
summary: S
status: ${status}
---

Body.
`)
      expect(findingsFor('stale-doc', checkDocs([d]))).toHaveLength(0)
    }
  })
})

describe('mixed-mode', () => {
  it('fires when a how-to document contains an explanation-shaped heading', () => {
    const d = doc(`${FM('kind: how-to\n')}## Why this matters

Background rationale, not steps.
`)
    expect(findingsFor('mixed-mode', checkDocs([d]))).toHaveLength(1)
  })

  it('fires when an explanation document contains numbered steps', () => {
    const d = doc(`${FM('kind: explanation\n')}1. Do this
2. Then this
`)
    expect(findingsFor('mixed-mode', checkDocs([d]))).toHaveLength(1)
  })

  it('stays silent when kind is absent', () => {
    const d = doc(`${FM()}## Why this matters

1. Do this
2. Then this
`)
    expect(findingsFor('mixed-mode', checkDocs([d]))).toHaveLength(0)
  })

  it('stays silent for a tutorial with a "why" heading (rule scoped to how-to/reference)', () => {
    const d = doc(`${FM('kind: tutorial\n')}## Why this matters

Prose.
`)
    expect(findingsFor('mixed-mode', checkDocs([d]))).toHaveLength(0)
  })
})

describe('relative-time and dangling-reference', () => {
  it('fires on relative time language', () => {
    const d = doc(`${FM()}This is currently the behavior, and it changed recently.\n`)
    const findings = findingsFor('relative-time', checkDocs([d]))
    expect(findings.length).toBeGreaterThan(0)
  })

  it('fires on a dangling reference', () => {
    const d = doc(`${FM()}As mentioned above, this applies everywhere.\n`)
    expect(findingsFor('dangling-reference', checkDocs([d]))).toHaveLength(1)
  })

  it('stays silent on ordinary prose', () => {
    const d = doc(`${FM()}This behavior is stable as of v2.0, documented on 2026-09-12.\n`)
    expect(findingsFor('relative-time', checkDocs([d]))).toHaveLength(0)
    expect(findingsFor('dangling-reference', checkDocs([d]))).toHaveLength(0)
  })
})

describe('checkExitCode', () => {
  it('is 0 when there are no findings', () => {
    expect(checkExitCode([], false)).toBe(0)
    expect(checkExitCode([], true)).toBe(0)
  })

  it('is 0 for warnings without --strict, and 1 with --strict — the only difference', () => {
    const findings = checkDocs([
      doc(`---
title: T
summary: S
status: stale
---

Body.
`),
    ])
    expect(checkExitCode(findings, false)).toBe(0)
    expect(checkExitCode(findings, true)).toBe(1)
  })

  it('is 1 for an error regardless of --strict', () => {
    const findings = checkDocs([
      doc(`${FM()}\`\`\`archify {type=workflow, src=./a.json}
\`\`\`
`),
    ])
    expect(checkExitCode(findings, false)).toBe(1)
    expect(checkExitCode(findings, true)).toBe(1)
  })
})

describe('the demo-shaped good document', () => {
  it('produces zero findings — a good document with two diagrams must not trip the linter', () => {
    const d = doc(`---
title: How contrail turns one Markdown file into three readable things
summary: The compile path from a single Markdown source to an interactive site for people, typed IR for agents, and a Plane page when the tier allows it.
status: current
kind: explanation
owner: docs-team
reviewedOn: 2026-09-01
---

A documentation tool has two audiences that want opposite things.

## The compile path

\`\`\`archify {type=architecture, src=./diagrams/pipeline.architecture.json, summary="A Markdown source and its Archify IR feed a single parse step."}
\`\`\`

The parse step runs once.

## Why diagrams are validated, not just rendered

Archify refuses to compile a diagram it cannot guarantee is readable.

| Gate | Catches |
| --- | --- |
| Schema | Missing fields |

## Writing a document contrail will accept

\`\`\`archify {type=workflow, src=./diagrams/authoring.workflow.json, summary="The authoring loop from draft to a clean contrail check run."}
\`\`\`

## What each reader gets

- [x] People get the interactive artifact
- [x] Agents get the typed IR
`)
    expect(checkDocs([d])).toEqual([])
  })
})

describe('llms.txt', () => {
  function config(root: string): Config {
    return {
      root,
      plane: { baseUrl: 'https://plane.test', workspace: 'acme' },
      repos: {},
      docs: ['./docs/**/*.md'],
    }
  }

  it('groups documents by kind, marks stale inline, and links a relative path', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-llms-'))
    const cfg = config(root)
    const a = doc(`---
title: Tutorial Doc
summary: A tutorial.
status: current
kind: tutorial
---

Body.
`)
    const b = doc(`---
title: Stale Reference
summary: A stale reference doc.
status: stale
kind: reference
---

Body.
`)
    const c = doc(`---
title: No Kind
summary: Uncategorized doc.
status: current
---

Body.
`)

    const txt = buildLlmsTxt(cfg, [a, b, c])
    // No docs/00-meta/project.yml in this fixture — the title falls back to
    // the directory name, never the Plane `workspace` slug (see the two
    // titling tests below).
    expect(txt).toMatch(new RegExp(`^# ${basename(root)}`))
    expect(txt).not.toContain('acme')
    expect(txt).toContain('## Tutorial')
    expect(txt).toContain('[Tutorial Doc]')
    expect(txt).toContain('## Reference')
    expect(txt).toContain('[Stale Reference]')
    expect(txt).toContain('(stale)')
    expect(txt).toContain('## Uncategorized')
    expect(txt).toContain('[No Kind]')
  })

  it('titles the index with the project name from docs/00-meta/project.yml when one exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-llms-titled-'))
    const cfg = config(root)
    mkdirSync(join(root, 'docs', '00-meta'), { recursive: true })
    writeFileSync(
      join(root, 'docs', '00-meta', 'project.yml'),
      'client: "Client Co"\nproject: "Consumer Portal Rebuild"\nstartDate: "2026-01-01"\n',
    )

    const txt = buildLlmsTxt(cfg, [])
    expect(txt).toMatch(/^# Consumer Portal Rebuild/)
    // The Plane workspace slug is an internal system identifier and must
    // never appear in this build, project.yml or not.
    expect(txt).not.toContain('acme')
  })

  it('falls back to the directory name, and never the Plane workspace slug, when project.yml is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-llms-untitled-'))
    const cfg = config(root)

    const txt = buildLlmsTxt(cfg, [])
    expect(txt).toMatch(new RegExp(`^# ${basename(root)}`))
    expect(txt).not.toContain('acme')
  })

  it('writeLlmsTxt writes to docs/llms.txt under the config root', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-llms-write-'))
    const cfg = config(root)
    const a = doc(`---
title: T
summary: S
status: current
---

Body.
`)
    const path = writeLlmsTxt(cfg, [a])
    expect(path).toBe(llmsTxtPath(cfg))
    expect(path).toBe(join(root, 'docs', 'llms.txt'))
  })
})
