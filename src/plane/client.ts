export interface CreatePageInput {
  name: string
  description_html: string
  parent_id?: string
  collection_id?: string
  access?: 0 | 1
}

export interface CreatePageResult {
  id: string
  /** True when Plane returned 202: the page exists, the parent link is still being made. */
  parentLinkPending: boolean
}

export interface PageRecord {
  id: string
  name: string
  description_html: string
  updated_at: string
}

export interface AssetUpload {
  asset_id: string
  upload_data: { url: string; fields: Record<string, string> }
}

export interface CreateProjectInput {
  name: string
  /** Plane's short project key, uppercase, unique per workspace, max 12 chars. */
  identifier: string
}

export interface ProjectRecord {
  id: string
  name: string
  identifier: string
  docs_view: boolean
}

/** Project creation, kept apart from `PlaneApi`.
 *
 * `PlaneApi` is the page-publishing surface; only `init` creates projects, and
 * folding the two together would make every page-publishing caller and test
 * double carry a method it never calls.
 */
export interface PlaneProjectApi {
  createProject(input: CreateProjectInput): Promise<ProjectRecord>
  /** Also the cheapest authenticated call there is, which is what `login` uses
   * to prove a pasted key works before saving it. */
  listProjects(): Promise<ProjectRecord[]>
}

export interface PlaneApi {
  createPage(input: CreatePageInput): Promise<CreatePageResult>
  getPage(pageId: string): Promise<PageRecord>
  updatePage(pageId: string, input: { name: string; description_html: string }): Promise<void>
  archivePage(pageId: string): Promise<void>
  createAssetUpload(input: {
    name: string
    type: string
    size: number
    entity_identifier: string
  }): Promise<AssetUpload>
  uploadAssetBytes(upload: AssetUpload, bytes: Uint8Array, contentType: string, filename: string): Promise<void>
  confirmAttachment(pageId: string, assetId: string): Promise<void>
}

export class PlaneApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
    this.name = 'PlaneApiError'
  }
}

export class PlaneClient implements PlaneApi, PlaneProjectApi {
  private readonly baseUrl: string
  private readonly workspace: string
  private readonly apiKey: string
  private readonly fetchFn: typeof fetch

  constructor(opts: { baseUrl: string; workspace: string; apiKey: string; fetchFn?: typeof fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.workspace = opts.workspace
    this.apiKey = opts.apiKey
    this.fetchFn = opts.fetchFn ?? fetch
  }

  private url(path: string): string {
    return `${this.baseUrl}/api/v1/workspaces/${this.workspace}${path}`
  }

  private async request(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = { 'X-API-Key': this.apiKey }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const response = await this.fetchFn(this.url(path), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    const text = await response.text()
    if (!response.ok) {
      throw new PlaneApiError(`Plane ${method} ${path} failed with ${response.status}`, response.status, text)
    }
    return { status: response.status, data: text ? JSON.parse(text) : {} }
  }

  async listProjects(): Promise<ProjectRecord[]> {
    const { data } = await this.request('GET', '/projects/')
    return (data as { results?: ProjectRecord[] }).results ?? []
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    // `docs_view` is what puts the Docs tab in a project's sidebar, and there is
    // no settings screen that turns it on. Creating the project without it
    // yields one whose docs can be deployed and never opened, so it is set here
    // rather than left as a step someone has to know about.
    const { data } = await this.request('POST', '/projects/', { ...input, docs_view: true })
    return data as ProjectRecord
  }

  async createPage(input: CreatePageInput): Promise<CreatePageResult> {
    if (input.parent_id && input.collection_id) {
      throw new Error('Plane rejects a page created with both parent_id and collection_id.')
    }
    const { status, data } = await this.request('POST', '/pages/', input)
    return { id: (data as { id: string }).id, parentLinkPending: status === 202 }
  }

  async getPage(pageId: string): Promise<PageRecord> {
    const { data } = await this.request('GET', `/pages/${pageId}/`)
    return data as PageRecord
  }

  async updatePage(pageId: string, input: { name: string; description_html: string }): Promise<void> {
    await this.request('PUT', `/pages/${pageId}/`, input)
  }

  async archivePage(pageId: string): Promise<void> {
    await this.request('POST', `/pages/${pageId}/archive/`)
  }

  async createAssetUpload(input: {
    name: string
    type: string
    size: number
    entity_identifier: string
  }): Promise<AssetUpload> {
    const { data } = await this.request('POST', '/assets/', { ...input, entity_type: 'PAGE_DESCRIPTION' })
    return data as AssetUpload
  }

  async uploadAssetBytes(
    upload: AssetUpload,
    bytes: Uint8Array,
    contentType: string,
    filename: string,
  ): Promise<void> {
    const form = new FormData()
    for (const [key, value] of Object.entries(upload.upload_data.fields)) form.append(key, value)
    form.append('file', new Blob([bytes as BlobPart], { type: contentType }), filename)

    // Deliberately no API key: this is object storage, a different trust boundary.
    const response = await this.fetchFn(upload.upload_data.url, { method: 'POST', body: form })
    if (!response.ok) {
      throw new PlaneApiError(`Asset upload failed with ${response.status}`, response.status, await response.text())
    }
  }

  async confirmAttachment(pageId: string, assetId: string): Promise<void> {
    await this.request('PATCH', `/pages/${pageId}/attachments/${assetId}/`, { is_uploaded: true })
  }
}
