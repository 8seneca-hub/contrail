import rehypeParse from 'rehype-parse'
import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'
import { planeSchema } from '../src/emit/plane-schema.js'

function clean(html: string): string {
  return String(
    unified()
      .use(rehypeParse, { fragment: true })
      .use(rehypeSanitize, planeSchema)
      .use(rehypeStringify)
      .processSync(html),
  )
}

describe('planeSchema', () => {
  it('strips tags Plane does not accept', () => {
    const out = clean('<p>keep</p><script>bad()</script><style>a{}</style><svg><circle/></svg><iframe src="https://x"></iframe>')
    expect(out).toBe('<p>keep</p>')
  })

  it('keeps the documented content tags', () => {
    const html = '<h2>T</h2><table><tbody><tr><td>c</td></tr></tbody></table><pre><code>x</code></pre><blockquote><p>q</p></blockquote>'
    expect(clean(html)).toBe(html)
  })

  it('keeps task list attributes', () => {
    const html = '<ul data-type="taskList"><li data-checked="true">done</li></ul>'
    expect(clean(html)).toBe(html)
  })

  it('keeps Plane component elements and their attributes', () => {
    const html = '<image-component id="a" src="b" width="320" height="160" alignment="left" status="uploaded"></image-component>'
    expect(clean(html)).toBe(html)
  })

  it('keeps callout div attributes but drops unrelated attributes on a plain div', () => {
    const calloutOut = clean('<div data-block-type="callout-component" data-background="#eff6ff"><p>note</p></div>')
    expect(calloutOut).toContain('data-block-type="callout-component"')
    expect(calloutOut).toContain('data-background="#eff6ff"')

    const plainOut = clean('<div class="wrapper"><p>x</p></div>')
    expect(plainOut).not.toContain('class')
    expect(plainOut).toContain('<p>x</p>')
  })

  it('drops unsafe URL protocols', () => {
    expect(clean('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>')
  })
})
