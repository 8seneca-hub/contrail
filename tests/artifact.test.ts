import { describe, expect, it } from 'vitest'
import { ArtifactBlockError, parseArtifactMeta } from '../src/blocks/artifact.js'

describe('parseArtifactMeta', () => {
  // Tests from the brief
  it('parses fallback and summary', () => {
    const meta = parseArtifactMeta('{fallback="./img/flow.png", summary="Settlement flow"}', 'flow.md:12')
    expect(meta).toEqual({ fallback: './img/flow.png', summary: 'Settlement flow' })
  })

  it('accepts single quotes and no braces', () => {
    const meta = parseArtifactMeta("fallback='a.png' summary='S'", 'flow.md:1')
    expect(meta.fallback).toBe('a.png')
  })

  it('rejects a block with no fallback, explaining why', () => {
    expect(() => parseArtifactMeta('{summary="S"}', 'flow.md:12')).toThrow(/flow\.md:12.*fallback/s)
  })

  it('rejects a block with no summary', () => {
    expect(() => parseArtifactMeta('{fallback="a.png"}', 'flow.md:12')).toThrow(ArtifactBlockError)
  })

  it('rejects an empty meta string', () => {
    expect(() => parseArtifactMeta(null, 'flow.md:12')).toThrow(ArtifactBlockError)
  })

  // Additional edge case tests
  describe('edge cases', () => {
    it('rejects a block missing BOTH fallback and summary', () => {
      expect(() => parseArtifactMeta('{}', 'flow.md:5')).toThrow(ArtifactBlockError)
      // The first missing field should throw first
      try {
        parseArtifactMeta('{}', 'flow.md:5')
      } catch (e) {
        expect((e as Error).message).toContain('fallback')
      }
    })

    it('handles meta being undefined', () => {
      expect(() => parseArtifactMeta(undefined, 'flow.md:10')).toThrow(ArtifactBlockError)
    })

    it('handles meta being an empty string', () => {
      expect(() => parseArtifactMeta('', 'flow.md:10')).toThrow(ArtifactBlockError)
    })

    it('parses attribute values containing spaces', () => {
      const meta = parseArtifactMeta(
        '{fallback="./img/my image.png", summary="Settlement flow with multiple steps"}',
        'flow.md:1'
      )
      expect(meta.fallback).toBe('./img/my image.png')
      expect(meta.summary).toBe('Settlement flow with multiple steps')
    })

    it('parses values containing the other quote style (apostrophe in double-quoted string)', () => {
      const meta = parseArtifactMeta(
        '{fallback="./img/flow.png", summary="It\'s a settlement flow"}',
        'flow.md:1'
      )
      expect(meta.summary).toBe("It's a settlement flow")
    })

    it('parses values containing double quotes in single-quoted string', () => {
      const meta = parseArtifactMeta(
        '{fallback=\'./img/flow.png\', summary=\'The "flow" diagram\'}',
        'flow.md:1'
      )
      expect(meta.summary).toBe('The "flow" diagram')
    })

    it('ignores extra unrecognized attributes', () => {
      const meta = parseArtifactMeta(
        '{fallback="a.png", summary="S", extra="ignored", another="also ignored"}',
        'flow.md:1'
      )
      expect(meta).toEqual({ fallback: 'a.png', summary: 'S' })
    })

    it('throws on empty fallback value', () => {
      expect(() => parseArtifactMeta('{fallback="", summary="S"}', 'flow.md:12')).toThrow(ArtifactBlockError)
      // Verify the error mentions fallback
      try {
        parseArtifactMeta('{fallback="", summary="S"}', 'flow.md:12')
      } catch (e) {
        expect((e as Error).message).toContain('fallback')
      }
    })

    it('throws on empty summary value', () => {
      expect(() => parseArtifactMeta('{fallback="a.png", summary=""}', 'flow.md:12')).toThrow(ArtifactBlockError)
      // Verify the error mentions summary
      try {
        parseArtifactMeta('{fallback="a.png", summary=""}', 'flow.md:12')
      } catch (e) {
        expect((e as Error).message).toContain('summary')
      }
    })

    it('error message includes the where location for missing fallback', () => {
      try {
        parseArtifactMeta('{summary="S"}', 'myfile.md:42')
        expect.fail('should have thrown')
      } catch (e) {
        expect((e as Error).message).toContain('myfile.md:42')
      }
    })

    it('error message includes the where location for missing summary', () => {
      try {
        parseArtifactMeta('{fallback="a.png"}', 'otherfile.md:99')
        expect.fail('should have thrown')
      } catch (e) {
        expect((e as Error).message).toContain('otherfile.md:99')
      }
    })

    it('handles attributes with no spaces around equals', () => {
      const meta = parseArtifactMeta(
        '{fallback="a.png",summary="S"}',
        'flow.md:1'
      )
      expect(meta).toEqual({ fallback: 'a.png', summary: 'S' })
    })

    it('handles attributes with spaces around equals', () => {
      const meta = parseArtifactMeta(
        '{fallback = "a.png", summary = "S"}',
        'flow.md:1'
      )
      expect(meta).toEqual({ fallback: 'a.png', summary: 'S' })
    })

    it('is case-sensitive for attribute names', () => {
      // FALLBACK (uppercase) should not match fallback (lowercase)
      expect(() => parseArtifactMeta('{FALLBACK="a.png", summary="S"}', 'flow.md:1')).toThrow(/fallback/)
    })

    it('throws ArtifactBlockError, not a generic Error', () => {
      expect(() => parseArtifactMeta('{summary="S"}', 'flow.md:1')).toThrow(ArtifactBlockError)
    })

    describe('escape handling', () => {
      it('unescapes escaped double quotes in double-quoted values', () => {
        const meta = parseArtifactMeta(
          '{fallback="a.png", summary="a \\"b\\" c"}',
          'flow.md:1'
        )
        expect(meta.summary).toBe('a "b" c')
      })

      it('unescapes escaped single quotes in single-quoted values', () => {
        const meta = parseArtifactMeta(
          "{fallback='a.png', summary='a \\'b\\' c'}",
          'flow.md:1'
        )
        expect(meta.summary).toBe("a 'b' c")
      })

      it('preserves literal backslashes that are not before a quote', () => {
        const meta = parseArtifactMeta(
          '{fallback="a.png", summary="path\\\\to\\\\file"}',
          'flow.md:1'
        )
        // \\\ in JSON becomes \\ in the string, then the first \\ escapes to \, and the second \ is before \, so \\ → \
        expect(meta.summary).toBe('path\\to\\file')
      })

      it('handles backslash-escaped quote at end of value', () => {
        const meta = parseArtifactMeta(
          '{fallback="a.png", summary="ends with \\""}',
          'flow.md:1'
        )
        expect(meta.summary).toBe('ends with "')
      })
    })

    it('last duplicate attribute wins', () => {
      const meta = parseArtifactMeta(
        '{fallback="first.png", fallback="second.png", summary="S"}',
        'flow.md:1'
      )
      expect(meta.fallback).toBe('second.png')
    })
  })
})
