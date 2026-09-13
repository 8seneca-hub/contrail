import type { Schema } from 'hast-util-sanitize'

/**
 * Plane sanitizes page HTML into its editor schema. Anything outside this set is
 * silently removed on write, so we apply the same rules locally as the final step
 * of emission — a mismatch then fails a test here rather than appearing as a
 * mysteriously empty page in Plane.
 */
export const planeSchema: Schema = {
  tagNames: [
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'em', 'u', 's', 'code', 'pre', 'a', 'br',
    'blockquote', 'ul', 'ol', 'li', 'hr',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'img', 'div',
    'mention-component', 'issue-embed-component', 'page-embed-component',
    'image-component', 'external-embed-component', 'attachment-component',
    'inline-math-component', 'block-math-component', 'inline-date-component',
  ],
  attributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'width', 'height'],
    ol: ['start'],
    ul: ['dataType'],
    li: ['dataChecked'],
    div: ['dataBlockType', 'dataBackground', 'dataLogoInUse', 'dataEmojiUnicode'],
    'image-component': ['id', 'src', 'width', 'height', 'alignment', 'status'],
    'attachment-component': ['id', 'src', 'status', 'dataName', 'dataFileSize', 'dataFileType'],
    'mention-component': ['id', 'entity_identifier', 'entity_name'],
    'issue-embed-component': [
      'id', 'entity_identifier', 'project_identifier', 'workspace_identifier', 'entity_name',
    ],
    'page-embed-component': ['id', 'entity_identifier', 'workspace_identifier', 'entity_name'],
    'external-embed-component': [
      'id', 'src', 'dataEntityName', 'dataEntityType', 'dataIsRichCard',
      'dataHasTriedEmbedding', 'dataHasEmbedFailed',
    ],
    'inline-math-component': ['id', 'latex'],
    'block-math-component': ['id', 'latex'],
    'inline-date-component': ['id', 'date'],
  },
  protocols: {
    href: ['http', 'https', 'mailto', 'tel'],
    src: ['http', 'https'],
  },
  strip: ['script', 'style'],
  clobber: [],
  ancestors: {},
}
