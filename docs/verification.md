# Live Plane verification

**Status: NOT YET RUN.** Nobody with Plane credentials has executed
`tests/integration/plane-live.test.ts` against a real instance yet. Every
answer below is a blank template, not a result — do not treat anything in
this file as confirmed until a real run fills it in.

This file exists so the person who runs the live verification records the
answer once, instead of everyone who touches this codebase re-deriving it
from scratch. See `tests/integration/plane-live.test.ts` for the test, and
the README's "Live verification" section for how to run it.

## Questions this file must answer

### 1. Plane version tested

- Plane instance URL (self-hosted or plane.so cloud):
- Plane version / build (from the instance's About or Settings page):
- Date tested:
- Tested by:

### 2. Does `<image-component src="...">` accept an uploaded asset's id?

`imageSrc()` in `src/emit/plane.ts` currently returns the bare asset id
unchanged, and `imageComponent()` puts that straight into
`<image-component src="...">`. Plane's docs show `<image-component
src="https://...">` for external images and `<attachment-component
src="ASSET_ID">` for uploaded ones, so this genuinely could go either way.

- [ ] Bare asset id in `src="..."` — diagram renders as a picture in the browser
- [ ] Bare asset id in `src="..."` — tag survives sanitization but the image is BROKEN in the browser
- [ ] Required switching to `asset_url` from `createAssetUpload` (or another value) instead — describe what worked:

_(fill in one of the above; leave the other boxes unchecked)_

If a change was required, it was made in `src/emit/plane.ts` /
`src/plane/publish.ts` (see the brief for the specific threading of
`asset_url` through `assetIds`) — link the commit here:

### 3. What did `description_html` look like when read back?

Paste the relevant excerpt of `page.description_html` as returned by
`client.getPage(pageId)` after publishing the smoke test document (see the
test for its exact source: body text, a `[!NOTE]` callout, a table, and a
mermaid diagram).

```html

```

### 4. What did the sanitizer strip or rewrite?

Compare the HTML `emitPlane()` produced (what contrail sent) against the
`description_html` Plane returned (what survived). Note every difference,
even cosmetic ones (attribute reordering, added wrapper elements, dropped
attributes).

- Callout (`data-block-type="callout-component"` div): survived / altered / stripped — details:
- Table: survived / altered / stripped — details:
- Image component: survived / altered / stripped — details:
- Anything else Plane rewrote:

## How this was verified

Not yet — see "Status" above. Once run, replace this line with the exact
command used, its output summary (pass/fail, test duration), and the page
id / URL that was manually inspected in a browser before archiving.
