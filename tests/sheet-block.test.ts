import { describe, expect, it } from 'vitest'
import { SheetBlockError, parseSheetMeta } from '../src/blocks/sheet.js'

describe('parseSheetMeta', () => {
  it('parses id, range and summary', () => {
    const meta = parseSheetMeta(
      '{id=abc123, range="Estimate!A1:E40", summary="Effort estimate by workstream, totalling 214 days."}',
      'estimate.md:12',
    )
    expect(meta).toEqual({
      id: 'abc123',
      range: 'Estimate!A1:E40',
      summary: 'Effort estimate by workstream, totalling 214 days.',
    })
  })

  it('accepts single quotes and no braces', () => {
    const meta = parseSheetMeta("id='abc123' range='Sheet1!A1:B2' summary='S'", 'estimate.md:1')
    expect(meta.id).toBe('abc123')
  })

  it('rejects a block with no id, explaining why', () => {
    expect(() => parseSheetMeta('{range="A1:B2", summary="S"}', 'estimate.md:12')).toThrow(/estimate\.md:12.*id/s)
  })

  it('rejects a block with no range', () => {
    expect(() => parseSheetMeta('{id=abc, summary="S"}', 'estimate.md:12')).toThrow(SheetBlockError)
    expect(() => parseSheetMeta('{id=abc, summary="S"}', 'estimate.md:12')).toThrow(/range/)
  })

  it('rejects a block with no summary', () => {
    expect(() => parseSheetMeta('{id=abc, range="A1:B2"}', 'estimate.md:12')).toThrow(SheetBlockError)
    expect(() => parseSheetMeta('{id=abc, range="A1:B2"}', 'estimate.md:12')).toThrow(/summary/)
  })

  it('rejects an empty meta string', () => {
    expect(() => parseSheetMeta(null, 'estimate.md:12')).toThrow(SheetBlockError)
    expect(() => parseSheetMeta(undefined, 'estimate.md:12')).toThrow(SheetBlockError)
  })
})
