import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDoc } from '../../src/parse.js'
import { PlaneClient } from '../../src/plane/client.js'
import { publishDocs } from '../../src/plane/publish.js'
import type { Lock } from '../../src/types.js'

// This suite only runs when a real Plane instance is configured. Without
// these three variables `describe.skipIf` skips the whole block, so
// `npx vitest run` stays green for anyone who has never touched Plane.
const live =
  Boolean(process.env.PLANE_API_KEY) &&
  Boolean(process.env.PLANE_BASE_URL) &&
  Boolean(process.env.PLANE_WORKSPACE)

describe.skipIf(!live)('live Plane instance', () => {
  it('publishes a document with a diagram and reads it back intact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-live-'))
    writeFileSync(
      join(root, 'contrail-smoke.md'),
      '---\ntitle: contrail smoke test\nsummary: Safe to delete.\nstatus: draft\n---\n\n' +
        'Body text.\n\n' +
        '> [!NOTE]\n> A callout, to see what the sanitizer does to it.\n\n' +
        '| Column A | Column B |\n| --- | --- |\n| alpha | beta |\n\n' +
        '```mermaid\ngraph TD; A-->B;\n```\n',
    )

    const config = {
      root,
      plane: { baseUrl: process.env.PLANE_BASE_URL!, workspace: process.env.PLANE_WORKSPACE! },
      repos: {},
      docs: ['./*.md'],
    }
    const client = new PlaneClient({ ...config.plane, apiKey: process.env.PLANE_API_KEY! })
    const lock: Lock = { version: 1, docs: {} }

    let pageId: string | undefined
    try {
      const result = await publishDocs({
        config,
        docs: [parseDoc(join(root, 'contrail-smoke.md'), root)],
        client,
        lock,
        cacheDir: join(root, '.cache'),
      })

      expect(result.created).toEqual(['contrail-smoke.md'])

      pageId = lock.docs['contrail-smoke.md']!.pageId
      const pageUrl = `${process.env.PLANE_BASE_URL}/${process.env.PLANE_WORKSPACE}/pages/${pageId}`
      // Print the id BEFORE any assertion runs: if an assertion below throws,
      // the finally block still archives the page, and this is the only
      // record of which page to have looked at.
      // eslint-disable-next-line no-console
      console.log(
        `Open this page in Plane before it is archived: ${pageUrl}\n` +
          'REMINDER: this test proves the markup survived Plane\'s sanitizer. ' +
          'It does NOT prove the diagram image renders — only a human looking at ' +
          'the page in a browser can confirm that. If the image is broken, ' +
          '`imageSrc()` in src/emit/plane.ts is the single place to change.',
      )

      const page = await client.getPage(pageId)

      // The assumption under test: does Plane accept an uploaded asset's bare
      // id in <image-component src="...">? This only proves the tag survived
      // sanitization, not that the id resolves to a viewable image.
      expect(page.description_html).toContain('image-component')

      // Round-trip checks beyond the image: does the rest of the emitted
      // HTML survive Plane's sanitizer intact?
      expect(page.description_html).toContain('Body text')
      expect(page.description_html).toContain('callout-component')
      expect(page.description_html.toLowerCase()).toContain('<table')
      expect(page.description_html).toContain('alpha')
    } finally {
      if (pageId) await client.archivePage(pageId)
    }
  }, 120_000)
})
