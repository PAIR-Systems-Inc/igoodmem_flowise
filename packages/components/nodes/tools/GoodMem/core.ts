import { z } from 'zod/v3'
import { DynamicStructuredTool } from '../OpenAPIToolkit/core'
import { TOOL_ARGS_PREFIX, formatToolError } from '../../../src/agents'
import { GoodMemClient, GoodMemClientOptions, GoodMemError } from './client'

export const desc = `Use this when you want to interact with GoodMem - a memory layer for AI agents that handles semantic storage, vector retrieval, and LLM-powered summarization.`

export interface GoodMemFactoryArgs extends GoodMemClientOptions {
    actions?: string[]
    defaultEmbedderId?: string
    defaultSpaceId?: string
}

const RECORD_OF_STRINGS = z.record(z.string()).optional()
const RECORD_OF_ANY = z.record(z.any()).optional()

// --- Schemas (argument names mirror the reference integration verbatim) ---
// Tools that operate on a single space (get/list/create-memory/retrieve) accept
// `space_id` as optional and fall back to the GoodMem node's "Default Space" if set.
// Destructive operations (update/delete) still require an explicit `space_id` so
// nothing can accidentally clobber the default.

const ListEmbeddersSchema = z.object({})

const ListSpacesSchema = z.object({})

const GetSpaceSchema = z.object({
    space_id: z
        .string()
        .optional()
        .describe('The UUID of the space to fetch. If omitted, the default space configured on the GoodMem node is used.')
})

const CreateSpaceSchema = z.object({
    name: z.string().describe('A unique name for the space.'),
    embedder_id: z
        .string()
        .optional()
        .describe(
            'The ID of the embedder model that converts text into vector representations for similarity search. If omitted, the default configured on the GoodMem node is used.'
        ),
    chunking_strategy: z
        .enum(['recursive', 'sentence', 'none'])
        .default('recursive')
        .describe("Chunking strategy for text processing. One of 'recursive', 'sentence', or 'none'."),
    chunk_size: z.number().int().default(512).describe('Maximum chunk size in characters (for recursive/sentence).'),
    chunk_overlap: z.number().int().default(50).describe('Overlap between consecutive chunks in characters.')
})

const UpdateSpaceSchema = z.object({
    space_id: z.string().describe('The UUID of the space to update.'),
    name: z.string().optional().describe('New name for the space (must be unique per owner).'),
    public_read: z.boolean().optional().describe('Whether the space should be readable by anyone.'),
    replace_labels: RECORD_OF_STRINGS.describe('If provided, replaces the entire label set with this mapping.'),
    merge_labels: RECORD_OF_STRINGS.describe('If provided, merges these labels into the existing label set.')
})

const DeleteSpaceSchema = z.object({
    space_id: z.string().describe('The UUID of the space to delete.')
})

const CreateMemorySchema = z.object({
    space_id: z
        .string()
        .optional()
        .describe('The UUID of the space to store the memory in. If omitted, the default space configured on the GoodMem node is used.'),
    text_content: z
        .string()
        .optional()
        .describe('Plain text content to store as memory. If both file_path and text_content are provided, the file takes priority.'),
    file_path: z
        .string()
        .optional()
        .describe('Local file path to upload as memory (PDF, DOCX, image, etc.). Content type is auto-detected from the extension.'),
    metadata: RECORD_OF_ANY.describe('Optional key-value metadata as a dictionary.')
})

const ListMemoriesSchema = z.object({
    space_id: z
        .string()
        .optional()
        .describe('The UUID of the space whose memories to list. If omitted, the default space configured on the GoodMem node is used.'),
    max_results: z.number().int().optional().describe('Maximum results per page. Server clamps to a sensible range.'),
    next_token: z.string().optional().describe('Opaque pagination token from a previous list_memories response.'),
    status_filter: z.string().optional().describe('Filter by processing status: PENDING, PROCESSING, COMPLETED, or FAILED.'),
    include_content: z.boolean().optional().default(false).describe('Whether to include the original content for each memory.'),
    filter_expression: z.string().optional().describe('Metadata filter expression using the GoodMem filter syntax.')
})

const GetMemorySchema = z.object({
    memory_id: z.string().describe('The UUID of the memory to fetch.'),
    include_content: z.boolean().optional().default(true).describe('Fetch the original document content alongside the metadata.')
})

const RetrieveMemoriesSchema = z.object({
    query: z.string().describe('A natural language query used to find semantically similar memory chunks.'),
    space_ids: z
        .string()
        .optional()
        .describe(
            "One or more space UUIDs to search across, separated by commas (e.g. 'id1,id2'). If omitted, the default space configured on the GoodMem node is used."
        ),
    max_results: z.number().int().optional().default(5).describe('Maximum number of matching chunks to return.'),
    include_memory_definition: z
        .boolean()
        .optional()
        .default(true)
        .describe('Fetch the full memory metadata (source document info, processing status) alongside the matched chunks.'),
    wait_for_indexing: z
        .boolean()
        .optional()
        .default(true)
        .describe(
            'Retry for up to 60 seconds when no results are found. Enable this when memories were just added and may still be undergoing chunking and embedding.'
        ),
    reranker_id: z.string().optional().describe('UUID of a reranker model to refine the order of retrieved chunks.'),
    llm_id: z.string().optional().describe('UUID of an LLM that will produce a contextual summary (abstractReply).'),
    relevance_threshold: z.number().optional().describe('Minimum relevance score (0-1) below which results are dropped.'),
    llm_temperature: z.number().optional().describe('Creativity setting for LLM generation (0-2).'),
    chronological_resort: z.boolean().optional().describe('Reorder final results by creation time after reranking and thresholding.')
})

const DeleteMemorySchema = z.object({
    memory_id: z.string().describe('The UUID of the memory to delete.')
})

// --- Base class ---
// Extends Flowise's DynamicStructuredTool (same base as Gmail/Stripe/etc.) so results
// participate in the TOOL_ARGS_PREFIX protocol the Flowise agent runner expects.

interface ToolArgs extends GoodMemClientOptions {
    defaultEmbedderId?: string
    defaultSpaceId?: string
}

abstract class BaseGoodMemTool extends DynamicStructuredTool {
    protected client: GoodMemClient
    protected defaultEmbedderId?: string
    protected defaultSpaceId?: string

    constructor(toolInput: any, args: ToolArgs) {
        super({
            ...toolInput,
            baseUrl: args.baseUrl,
            method: 'POST',
            headers: {}
        })
        this.client = new GoodMemClient(args)
        this.defaultEmbedderId = args.defaultEmbedderId
        this.defaultSpaceId = args.defaultSpaceId
    }

    /** Resolve a single space_id from the tool call, falling back to the node's default. */
    protected resolveSpaceId(provided: string | undefined): string {
        const id = provided ?? this.defaultSpaceId
        if (!id) {
            throw new GoodMemError(
                'space_id is required. Either pass it in the tool call or set a Default Space on the GoodMem node.'
            )
        }
        return id
    }

    /** Resolve the comma-separated space_ids string for retrieve_memories. */
    protected resolveSpaceIds(provided: string | undefined): string {
        const ids = provided ?? this.defaultSpaceId
        if (!ids) {
            throw new GoodMemError(
                'space_ids is required. Either pass them in the tool call or set a Default Space on the GoodMem node.'
            )
        }
        return ids
    }

    protected ok(result: any, params: any): string {
        return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
    }

    protected fail(err: unknown, params: any): string {
        let message: string
        if (err instanceof GoodMemError) {
            message = err.message
        } else if (err instanceof Error) {
            message = err.message
        } else {
            message = String(err)
        }
        return formatToolError(message, params)
    }
}

// --- Tools ---

class ListEmbeddersTool extends BaseGoodMemTool {
    constructor(args: ToolArgs) {
        super(
            {
                name: 'goodmem_list_embedders',
                description:
                    'List all available GoodMem embedder models. Use the returned embedderId when creating a new space.',
                schema: ListEmbeddersSchema
            },
            args
        )
    }

    async _call(arg: z.infer<typeof ListEmbeddersSchema>): Promise<string> {
        try {
            const embedders = await this.client.listEmbedders()
            return this.ok({ success: true, embedders, totalEmbedders: embedders.length }, arg)
        } catch (err) {
            return this.fail(err, arg)
        }
    }
}

class ListSpacesTool extends BaseGoodMemTool {
    constructor(args: ToolArgs) {
        super(
            {
                name: 'goodmem_list_spaces',
                description:
                    'List all GoodMem spaces. Returns each space with its ID, name, embedder configuration, and access settings.',
                schema: ListSpacesSchema
            },
            args
        )
    }

    async _call(arg: z.infer<typeof ListSpacesSchema>): Promise<string> {
        try {
            const spaces = await this.client.listSpaces()
            return this.ok({ success: true, spaces, totalSpaces: spaces.length }, arg)
        } catch (err) {
            return this.fail(err, arg)
        }
    }
}

class GetSpaceTool extends BaseGoodMemTool {
    constructor(args: ToolArgs) {
        super(
            {
                name: 'goodmem_get_space',
                description:
                    'Fetch a specific GoodMem space by its ID, including name, labels, embedder configuration, and chunking settings.',
                schema: GetSpaceSchema
            },
            args
        )
    }

    async _call(arg: z.infer<typeof GetSpaceSchema>): Promise<string> {
        try {
            const spaceId = this.resolveSpaceId(arg.space_id)
            const space = await this.client.getSpace(spaceId)
            return this.ok({ success: true, space }, { ...arg, space_id: spaceId })
        } catch (err) {
            return this.fail(err, arg)
        }
    }
}

class CreateSpaceTool extends BaseGoodMemTool {
    constructor(args: ToolArgs) {
        super(
            {
                name: 'goodmem_create_space',
                description:
                    'Create a new GoodMem space or reuse an existing one. A space is a logical container for organizing related memories, configured with an embedder for vector search.',
                schema: CreateSpaceSchema
            },
            args
        )
    }

    async _call(arg: z.infer<typeof CreateSpaceSchema>): Promise<string> {
        try {
            const embedderId = arg.embedder_id ?? this.defaultEmbedderId
            if (!embedderId) {
                return this.fail(
                    new GoodMemError(
                        'embedder_id is required. Either pass it in the tool call or configure a default embedder on the GoodMem node.'
                    ),
                    arg
                )
            }
            const result = await this.client.createSpace({
                name: arg.name,
                embedder_id: embedderId,
                chunking_strategy: arg.chunking_strategy,
                chunk_size: arg.chunk_size,
                chunk_overlap: arg.chunk_overlap
            })
            return this.ok(result, arg)
        } catch (err) {
            return this.fail(err, arg)
        }
    }
}

class UpdateSpaceTool extends BaseGoodMemTool {
    constructor(args: ToolArgs) {
        super(
            {
                name: 'goodmem_update_space',
                description:
                    'Update mutable fields on a GoodMem space (name, publicRead, labels). Embedders and chunking config cannot be changed after creation.',
                schema: UpdateSpaceSchema
            },
            args
        )
    }

    async _call(arg: z.infer<typeof UpdateSpaceSchema>): Promise<string> {
        try {
            const space = await this.client.updateSpace(arg)
            return this.ok(
                { success: true, spaceId: space.spaceId ?? arg.space_id, space, message: 'Space updated successfully' },
                arg
            )
        } catch (err) {
            return this.fail(err, arg)
        }
    }
}

class DeleteSpaceTool extends BaseGoodMemTool {
    constructor(args: ToolArgs) {
        super(
            {
                name: 'goodmem_delete_space',
                description:
                    'Permanently delete a GoodMem space and any data associated with it. This action cannot be undone.',
                schema: DeleteSpaceSchema
            },
            args
        )
    }

    async _call(arg: z.infer<typeof DeleteSpaceSchema>): Promise<string> {
        try {
            const result = await this.client.deleteSpace(arg.space_id)
            return this.ok(result, arg)
        } catch (err) {
            return this.fail(err, arg)
        }
    }
}

class CreateMemoryTool extends BaseGoodMemTool {
    constructor(args: ToolArgs) {
        super(
            {
                name: 'goodmem_create_memory',
                description:
                    'Store a document as a new memory in a GoodMem space. Accepts a local file path or plain text. The memory is chunked and embedded asynchronously.',
                schema: CreateMemorySchema
            },
            args
        )
    }

    async _call(arg: z.infer<typeof CreateMemorySchema>): Promise<string> {
        try {
            const spaceId = this.resolveSpaceId(arg.space_id)
            const result = await this.client.createMemory({ ...arg, space_id: spaceId })
            return this.ok(result, { ...arg, space_id: spaceId })
        } catch (err) {
            return this.fail(err, arg)
        }
    }
}

class ListMemoriesTool extends BaseGoodMemTool {
    constructor(args: ToolArgs) {
        super(
            {
                name: 'goodmem_list_memories',
                description:
                    'List memories in a GoodMem space, with optional pagination, status filtering, and metadata filter expressions.',
                schema: ListMemoriesSchema
            },
            args
        )
    }

    async _call(arg: z.infer<typeof ListMemoriesSchema>): Promise<string> {
        try {
            const spaceId = this.resolveSpaceId(arg.space_id)
            const result = await this.client.listMemories({ ...arg, space_id: spaceId })
            return this.ok(result, { ...arg, space_id: spaceId })
        } catch (err) {
            return this.fail(err, arg)
        }
    }
}

class GetMemoryTool extends BaseGoodMemTool {
    constructor(args: ToolArgs) {
        super(
            {
                name: 'goodmem_get_memory',
                description:
                    'Fetch a specific GoodMem memory by its ID, including metadata, processing status, and optionally the original content.',
                schema: GetMemorySchema
            },
            args
        )
    }

    async _call(arg: z.infer<typeof GetMemorySchema>): Promise<string> {
        try {
            const result = await this.client.getMemory(arg.memory_id, arg.include_content)
            return this.ok(result, arg)
        } catch (err) {
            return this.fail(err, arg)
        }
    }
}

class RetrieveMemoriesTool extends BaseGoodMemTool {
    constructor(args: ToolArgs) {
        super(
            {
                name: 'goodmem_retrieve_memories',
                description:
                    'Perform similarity-based semantic retrieval across one or more GoodMem spaces. Returns matching chunks ranked by relevance, optionally with a contextual LLM summary.',
                schema: RetrieveMemoriesSchema
            },
            args
        )
    }

    async _call(arg: z.infer<typeof RetrieveMemoriesSchema>): Promise<string> {
        try {
            const spaceIds = this.resolveSpaceIds(arg.space_ids)
            const result = await this.client.retrieveMemories({ ...arg, space_ids: spaceIds })
            return this.ok(result, { ...arg, space_ids: spaceIds })
        } catch (err) {
            return this.fail(err, arg)
        }
    }
}

class DeleteMemoryTool extends BaseGoodMemTool {
    constructor(args: ToolArgs) {
        super(
            {
                name: 'goodmem_delete_memory',
                description: 'Permanently delete a GoodMem memory and its associated chunks and vector embeddings.',
                schema: DeleteMemorySchema
            },
            args
        )
    }

    async _call(arg: z.infer<typeof DeleteMemorySchema>): Promise<string> {
        try {
            const result = await this.client.deleteMemory(arg.memory_id)
            return this.ok(result, arg)
        } catch (err) {
            return this.fail(err, arg)
        }
    }
}

// --- Factory ---

export const GOODMEM_ACTIONS = [
    'listEmbedders',
    'listSpaces',
    'getSpace',
    'createSpace',
    'updateSpace',
    'deleteSpace',
    'createMemory',
    'listMemories',
    'getMemory',
    'retrieveMemories',
    'deleteMemory'
] as const

export type GoodMemAction = (typeof GOODMEM_ACTIONS)[number]

export const createGoodMemTools = (args: GoodMemFactoryArgs): DynamicStructuredTool[] => {
    const tools: DynamicStructuredTool[] = []
    const actions = args.actions && args.actions.length > 0 ? args.actions : (GOODMEM_ACTIONS as readonly string[])

    if (actions.includes('listEmbedders')) tools.push(new ListEmbeddersTool(args))
    if (actions.includes('listSpaces')) tools.push(new ListSpacesTool(args))
    if (actions.includes('getSpace')) tools.push(new GetSpaceTool(args))
    if (actions.includes('createSpace')) tools.push(new CreateSpaceTool(args))
    if (actions.includes('updateSpace')) tools.push(new UpdateSpaceTool(args))
    if (actions.includes('deleteSpace')) tools.push(new DeleteSpaceTool(args))
    if (actions.includes('createMemory')) tools.push(new CreateMemoryTool(args))
    if (actions.includes('listMemories')) tools.push(new ListMemoriesTool(args))
    if (actions.includes('getMemory')) tools.push(new GetMemoryTool(args))
    if (actions.includes('retrieveMemories')) tools.push(new RetrieveMemoriesTool(args))
    if (actions.includes('deleteMemory')) tools.push(new DeleteMemoryTool(args))

    return tools
}
