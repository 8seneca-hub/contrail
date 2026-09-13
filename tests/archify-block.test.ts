import { describe, expect, it } from 'vitest'
import { ArchifyBlockError, parseArchifyMeta, type ArchifyType } from '../src/blocks/archify.js'

describe('parseArchifyMeta', () => {
  it('parses type, src and summary', () => {
    const meta = parseArchifyMeta(
      '{type=workflow, src=./diagrams/tool-call.workflow.json, summary="How a tool call flows"}',
      'flow.md:12',
    )
    expect(meta).toEqual({
      type: 'workflow',
      src: './diagrams/tool-call.workflow.json',
      summary: 'How a tool call flows',
    })
  })

  it('accepts bare (unquoted) type and src, matching the plan authoring example', () => {
    const meta = parseArchifyMeta(
      '{type=workflow, src=./diagrams/tool-call.workflow.json, summary="S"}',
      'flow.md:1',
    )
    expect(meta.type).toBe('workflow')
    expect(meta.src).toBe('./diagrams/tool-call.workflow.json')
  })

  it('accepts single quotes and no braces', () => {
    const meta = parseArchifyMeta("type='architecture' src='a.json' summary='S'", 'flow.md:1')
    expect(meta.type).toBe('architecture')
    expect(meta.src).toBe('a.json')
  })

  const VALID_TYPES: ArchifyType[] = ['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle']
  it.each(VALID_TYPES)('accepts the %s type', (type) => {
    const meta = parseArchifyMeta(`{type=${type}, src="a.json", summary="S"}`, 'flow.md:1')
    expect(meta.type).toBe(type)
  })

  it('rejects an unknown type, naming the allowed set', () => {
    expect(() => parseArchifyMeta('{type=bogus, src="a.json", summary="S"}', 'flow.md:12')).toThrow(
      /architecture, workflow, sequence, dataflow, lifecycle/,
    )
  })

  it('rejects a missing type, naming the allowed set', () => {
    expect(() => parseArchifyMeta('{src="a.json", summary="S"}', 'flow.md:12')).toThrow(
      /architecture, workflow, sequence, dataflow, lifecycle/,
    )
  })

  it('rejects a block with no src', () => {
    expect(() => parseArchifyMeta('{type=workflow, summary="S"}', 'flow.md:12')).toThrow(ArchifyBlockError)
    expect(() => parseArchifyMeta('{type=workflow, summary="S"}', 'flow.md:12')).toThrow(/src/)
  })

  it('rejects a block with no summary, explaining why it is mandatory', () => {
    expect(() => parseArchifyMeta('{type=workflow, src="a.json"}', 'flow.md:12')).toThrow(ArchifyBlockError)
    try {
      parseArchifyMeta('{type=workflow, src="a.json"}', 'flow.md:12')
      expect.fail('should have thrown')
    } catch (e) {
      expect((e as Error).message).toMatch(/agent reading the/)
      expect((e as Error).message).toMatch(/summary/)
    }
  })

  it('rejects an empty meta string', () => {
    expect(() => parseArchifyMeta('', 'flow.md:12')).toThrow(ArchifyBlockError)
  })

  it('rejects null and undefined meta', () => {
    expect(() => parseArchifyMeta(null, 'flow.md:1')).toThrow(ArchifyBlockError)
    expect(() => parseArchifyMeta(undefined, 'flow.md:1')).toThrow(ArchifyBlockError)
  })

  describe('error location', () => {
    it('always includes the `where` location for an invalid type', () => {
      expect(() => parseArchifyMeta('{src="a.json", summary="S"}', 'docs/flow.md:42')).toThrow(
        /docs\/flow\.md:42/,
      )
    })

    it('always includes the `where` location for a missing src', () => {
      expect(() => parseArchifyMeta('{type=workflow, summary="S"}', 'docs/flow.md:43')).toThrow(
        /docs\/flow\.md:43/,
      )
    })

    it('always includes the `where` location for a missing summary', () => {
      expect(() => parseArchifyMeta('{type=workflow, src="a.json"}', 'docs/flow.md:44')).toThrow(
        /docs\/flow\.md:44/,
      )
    })
  })

  it('ignores extra unrecognised attributes', () => {
    const meta = parseArchifyMeta(
      '{type=dataflow, src="a.json", summary="S", extra="ignored", quality="showcase"}',
      'flow.md:1',
    )
    expect(meta).toEqual({ type: 'dataflow', src: 'a.json', summary: 'S' })
  })

  it('reuses the shared escape handling (escaped quotes in summary)', () => {
    const meta = parseArchifyMeta(
      '{type=sequence, src="a.json", summary="a \\"b\\" c"}',
      'flow.md:1',
    )
    expect(meta.summary).toBe('a "b" c')
  })

  it('throws ArchifyBlockError, not a generic Error', () => {
    expect(() => parseArchifyMeta('{src="a.json", summary="S"}', 'flow.md:1')).toThrow(ArchifyBlockError)
  })
})
