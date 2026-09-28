/**
 * FROZEN BASELINE -- Flowise GoodMem node at commit 0118886e.
 *
 * byte-identical to the audited commit.
 * Kept so the defects this audit reported stay reproducible after the
 * rewrite shipped. Not built, not shipped: `audit` is excluded from
 * tsconfig and from the published package.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as https from 'https'
import fetch, { RequestInit, Response } from 'node-fetch'

/**
 * Low-level HTTP client for communicating with the GoodMem API.
 *
 * Mirrors the behavior of the official langgraph-goodmem `_client.py` so
 * agent prompts written against any GoodMem integration produce the same
 * request/response shapes here.
 */

export interface GoodMemClientOptions {
    baseUrl: string
    apiKey: string
    timeoutMs?: number
    verifySsl?: boolean
}

export interface CreateSpaceArgs {
    name: string
    embedder_id: string
    chunking_strategy?: string
    chunk_size?: number
    chunk_overlap?: number
}

export interface UpdateSpaceArgs {
    space_id: string
    name?: string
    public_read?: boolean
    replace_labels?: Record<string, string>
    merge_labels?: Record<string, string>
}

export interface CreateMemoryArgs {
    space_id: string
    text_content?: string
    file_path?: string
    metadata?: Record<string, any>
}

export interface RetrieveMemoriesArgs {
    query: string
    space_ids: string
    max_results?: number
    include_memory_definition?: boolean
    wait_for_indexing?: boolean
    reranker_id?: string
    llm_id?: string
    relevance_threshold?: number
    llm_temperature?: number
    chronological_resort?: boolean
}

export interface ListMemoriesArgs {
    space_id: string
    max_results?: number
    next_token?: string
    status_filter?: string
    include_content?: boolean
    filter_expression?: string
}

const CHAT_POSTPROCESSOR = 'com.goodmem.retrieval.postprocess.ChatPostProcessorFactory'
const DEFAULT_TIMEOUT_MS = 30_000

const MIME_BY_EXT: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.webp': 'image/webp'
}

function guessMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase()
    return MIME_BY_EXT[ext] || 'application/octet-stream'
}

async function readErrorBody(response: Response): Promise<string> {
    try {
        const text = await response.text()
        return text || response.statusText
    } catch (_) {
        return response.statusText
    }
}

export class GoodMemError extends Error {
    status?: number
    body?: string
    constructor(message: string, status?: number, body?: string) {
        super(message)
        this.name = 'GoodMemError'
        this.status = status
        this.body = body
    }
}

export class GoodMemClient {
    private baseUrl: string
    private apiKey: string
    private timeoutMs: number
    private agent?: https.Agent

    constructor(options: GoodMemClientOptions) {
        if (!options.baseUrl) {
            throw new GoodMemError('GoodMem base URL is required')
        }
        if (!options.apiKey) {
            throw new GoodMemError('GoodMem API key is required')
        }
        this.baseUrl = options.baseUrl.replace(/\/+$/, '')
        this.apiKey = options.apiKey
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
        // Only build a custom agent when we need to disable TLS verification
        // and the target is https. node-fetch only honours the agent for the
        // matching protocol, so the default behaviour stays correct for http.
        if (options.verifySsl === false) {
            this.agent = new https.Agent({ rejectUnauthorized: false })
        }
    }

    private headers(contentType = 'application/json', accept = 'application/json'): Record<string, string> {
        return {
            'X-API-Key': this.apiKey,
            'Content-Type': contentType,
            Accept: accept
        }
    }

    private url(p: string): string {
        return `${this.baseUrl}${p}`
    }

    private async request(p: string, init: RequestInit): Promise<Response> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeoutMs)
        try {
            const response = await fetch(this.url(p), {
                ...init,
                agent: this.agent,
                signal: controller.signal as any
            })
            if (!response.ok) {
                const body = await readErrorBody(response)
                throw new GoodMemError(
                    `GoodMem API ${init.method ?? 'GET'} ${p} failed: ${response.status} ${response.statusText} - ${body}`,
                    response.status,
                    body
                )
            }
            return response
        } catch (err: any) {
            if (err instanceof GoodMemError) throw err
            if (err?.name === 'AbortError') {
                throw new GoodMemError(`GoodMem API ${init.method ?? 'GET'} ${p} timed out after ${this.timeoutMs}ms`)
            }
            throw new GoodMemError(`GoodMem API ${init.method ?? 'GET'} ${p} request failed: ${err?.message ?? err}`)
        } finally {
            clearTimeout(timer)
        }
    }

    // -- Space operations --

    async createSpace(args: CreateSpaceArgs): Promise<Record<string, any>> {
        const chunkingStrategy = args.chunking_strategy ?? 'recursive'
        const chunkSize = args.chunk_size ?? 512
        const chunkOverlap = args.chunk_overlap ?? 50

        // Mirror the reference behavior: dedupe by name before creating.
        try {
            const spaces = await this.listSpaces()
            for (const space of spaces) {
                if (space?.name === args.name) {
                    return {
                        success: true,
                        spaceId: space.spaceId,
                        name: space.name,
                        embedderId: args.embedder_id,
                        message: 'Space already exists, reusing existing space',
                        reused: true
                    }
                }
            }
        } catch (_) {
            // If listing fails, proceed to create
        }

        const chunkingConfig: Record<string, any> =
            chunkingStrategy === 'none' ? { none: {} } : { [chunkingStrategy]: { chunkSize, chunkOverlap } }

        const response = await this.request('/v1/spaces', {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({
                name: args.name,
                spaceEmbedders: [{ embedderId: args.embedder_id }],
                defaultChunkingConfig: chunkingConfig
            })
        })
        const body = (await response.json()) as Record<string, any>
        return {
            success: true,
            spaceId: body.spaceId,
            name: body.name,
            embedderId: args.embedder_id,
            message: 'Space created successfully',
            reused: false
        }
    }

    async listSpaces(): Promise<Record<string, any>[]> {
        const response = await this.request('/v1/spaces', { method: 'GET', headers: this.headers() })
        const body = (await response.json()) as any
        if (Array.isArray(body)) return body
        return body?.spaces ?? []
    }

    async getSpace(spaceId: string): Promise<Record<string, any>> {
        const response = await this.request(`/v1/spaces/${encodeURIComponent(spaceId)}`, {
            method: 'GET',
            headers: this.headers()
        })
        return (await response.json()) as Record<string, any>
    }

    async updateSpace(args: UpdateSpaceArgs): Promise<Record<string, any>> {
        const body: Record<string, any> = {}
        if (args.name !== undefined) body.name = args.name
        if (args.public_read !== undefined) body.publicRead = args.public_read
        if (args.replace_labels !== undefined) body.replaceLabels = args.replace_labels
        if (args.merge_labels !== undefined) body.mergeLabels = args.merge_labels

        const response = await this.request(`/v1/spaces/${encodeURIComponent(args.space_id)}`, {
            method: 'PUT',
            headers: this.headers(),
            body: JSON.stringify(body)
        })
        return (await response.json()) as Record<string, any>
    }

    async deleteSpace(spaceId: string): Promise<Record<string, any>> {
        await this.request(`/v1/spaces/${encodeURIComponent(spaceId)}`, {
            method: 'DELETE',
            headers: this.headers()
        })
        return {
            success: true,
            spaceId,
            message: 'Space deleted successfully'
        }
    }

    // -- Memory operations --

    async createMemory(args: CreateMemoryArgs): Promise<Record<string, any>> {
        const requestBody: Record<string, any> = { spaceId: args.space_id }

        if (args.file_path) {
            const filePath = args.file_path
            if (!fs.existsSync(filePath)) {
                throw new GoodMemError(`File not found: ${filePath}`)
            }
            const mimeType = guessMimeType(filePath)
            const fileBytes = fs.readFileSync(filePath)
            requestBody.contentType = mimeType
            if (mimeType.startsWith('text/')) {
                requestBody.originalContent = fileBytes.toString('utf-8')
            } else {
                requestBody.originalContentB64 = fileBytes.toString('base64')
            }
        } else if (args.text_content !== undefined && args.text_content !== null) {
            requestBody.contentType = 'text/plain'
            requestBody.originalContent = args.text_content
        } else {
            throw new GoodMemError('No content provided. Provide either text_content or file_path.')
        }

        if (args.metadata) {
            requestBody.metadata = args.metadata
        }

        const response = await this.request('/v1/memories', {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify(requestBody)
        })
        const body = (await response.json()) as Record<string, any>
        return {
            success: true,
            memoryId: body.memoryId,
            spaceId: body.spaceId,
            status: body.processingStatus ?? 'PENDING',
            contentType: requestBody.contentType,
            message: 'Memory created successfully'
        }
    }

    async getMemory(memoryId: string, includeContent = true): Promise<Record<string, any>> {
        const response = await this.request(`/v1/memories/${encodeURIComponent(memoryId)}`, {
            method: 'GET',
            headers: this.headers()
        })
        const memory = (await response.json()) as Record<string, any>
        const result: Record<string, any> = { success: true, memory }

        if (includeContent) {
            try {
                const contentResponse = await this.request(`/v1/memories/${encodeURIComponent(memoryId)}/content`, {
                    method: 'GET',
                    headers: this.headers()
                })
                const contentType = contentResponse.headers.get('content-type') ?? ''
                if (contentType.includes('application/json')) {
                    result.content = await contentResponse.json()
                } else {
                    result.content = await contentResponse.text()
                }
            } catch (err: any) {
                result.contentError = `Failed to fetch content: ${err?.message ?? err}`
            }
        }

        return result
    }

    async listMemories(args: ListMemoriesArgs): Promise<Record<string, any>> {
        const params = new URLSearchParams()
        if (args.max_results !== undefined && args.max_results !== null) params.append('maxResults', String(args.max_results))
        if (args.next_token) params.append('nextToken', args.next_token)
        if (args.status_filter) params.append('statusFilter', args.status_filter)
        if (args.include_content) params.append('includeContent', 'true')
        if (args.filter_expression) params.append('filter', args.filter_expression)

        const query = params.toString()
        const path = `/v1/spaces/${encodeURIComponent(args.space_id)}/memories${query ? `?${query}` : ''}`
        const response = await this.request(path, { method: 'GET', headers: this.headers() })
        const body = (await response.json()) as any
        const memories = Array.isArray(body?.memories) ? body.memories : []
        return {
            success: true,
            spaceId: args.space_id,
            memories,
            totalMemories: memories.length,
            nextToken: body?.nextToken ?? null
        }
    }

    async deleteMemory(memoryId: string): Promise<Record<string, any>> {
        await this.request(`/v1/memories/${encodeURIComponent(memoryId)}`, {
            method: 'DELETE',
            headers: this.headers()
        })
        return {
            success: true,
            memoryId,
            message: 'Memory deleted successfully'
        }
    }

    async retrieveMemories(args: RetrieveMemoriesArgs): Promise<Record<string, any>> {
        const spaceKeys = args.space_ids
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .map((spaceId) => ({ spaceId }))
        if (spaceKeys.length === 0) {
            throw new GoodMemError('At least one valid Space ID is required.')
        }

        const maxResults = args.max_results ?? 5
        const requestBody: Record<string, any> = {
            message: args.query,
            spaceKeys,
            requestedSize: maxResults,
            fetchMemory: args.include_memory_definition ?? true
        }

        const postConfig: Record<string, any> = {}
        if (args.reranker_id !== undefined && args.reranker_id !== null) postConfig.reranker_id = args.reranker_id
        if (args.llm_id !== undefined && args.llm_id !== null) postConfig.llm_id = args.llm_id
        if (args.relevance_threshold !== undefined && args.relevance_threshold !== null)
            postConfig.relevance_threshold = args.relevance_threshold
        if (args.llm_temperature !== undefined && args.llm_temperature !== null) postConfig.llm_temp = args.llm_temperature
        if (args.chronological_resort !== undefined && args.chronological_resort !== null)
            postConfig.chronological_resort = args.chronological_resort
        if (Object.keys(postConfig).length > 0) {
            if (postConfig.max_results === undefined) postConfig.max_results = maxResults
            requestBody.postProcessor = { name: CHAT_POSTPROCESSOR, config: postConfig }
        }

        const waitForIndexing = args.wait_for_indexing ?? true
        const maxWaitMs = 60_000
        const pollIntervalMs = 5_000
        const start = Date.now()
        let lastResult: Record<string, any> | null = null

        // eslint-disable-next-line no-constant-condition
        while (true) {
            const response = await this.request('/v1/memories:retrieve', {
                method: 'POST',
                headers: this.headers('application/json', 'application/x-ndjson'),
                body: JSON.stringify(requestBody)
            })
            const responseText = await response.text()

            const results: Record<string, any>[] = []
            const memories: Record<string, any>[] = []
            let resultSetId = ''
            let abstractReply: Record<string, any> | null = null

            for (const rawLine of responseText.split('\n')) {
                let line = rawLine.trim()
                if (!line) continue
                if (line.startsWith('data:')) line = line.slice(5).trim()
                if (!line || line.startsWith('event:')) continue
                try {
                    const item = JSON.parse(line)
                    if (item.resultSetBoundary) {
                        resultSetId = item.resultSetBoundary.resultSetId ?? ''
                    } else if (item.memoryDefinition) {
                        memories.push(item.memoryDefinition)
                    } else if (item.abstractReply) {
                        abstractReply = item.abstractReply
                    } else if (item.retrievedItem) {
                        const ri = item.retrievedItem
                        const chunkData = ri.chunk ?? {}
                        const chunk = chunkData.chunk ?? {}
                        results.push({
                            chunkId: chunk.chunkId,
                            chunkText: chunk.chunkText,
                            memoryId: chunk.memoryId,
                            relevanceScore: chunkData.relevanceScore,
                            memoryIndex: chunkData.memoryIndex
                        })
                    }
                } catch (_) {
                    continue
                }
            }

            lastResult = {
                success: true,
                resultSetId,
                results,
                memories,
                totalResults: results.length,
                query: args.query
            }
            if (abstractReply !== null) {
                lastResult.abstractReply = abstractReply
            }

            if (results.length > 0 || !waitForIndexing) {
                return lastResult
            }

            const elapsed = Date.now() - start
            if (elapsed >= maxWaitMs) {
                lastResult.message = 'No results found after waiting 60 seconds for indexing. Memories may still be processing.'
                return lastResult
            }

            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
        }
    }

    async listEmbedders(): Promise<Record<string, any>[]> {
        const response = await this.request('/v1/embedders', { method: 'GET', headers: this.headers() })
        const body = (await response.json()) as any
        if (Array.isArray(body)) return body
        return body?.embedders ?? []
    }
}
