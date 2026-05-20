import { convertMultiOptionsToStringArray, getCredentialData, getCredentialParam } from '../../../src/utils'
import { ICommonObject, INode, INodeData, INodeOptionsValue, INodeParams } from '../../../src/Interface'
import { createGoodMemTools, GoodMemAction, GOODMEM_ACTIONS } from './core'
import { GoodMemClient } from './client'

const ALL_ACTION_OPTIONS: { label: string; name: GoodMemAction; description: string }[] = [
    {
        label: 'List Embedders',
        name: 'listEmbedders',
        description: 'List available embedder models'
    },
    {
        label: 'List Spaces',
        name: 'listSpaces',
        description: 'List all spaces accessible to the API key'
    },
    {
        label: 'Get Space',
        name: 'getSpace',
        description: 'Fetch a space by ID'
    },
    {
        label: 'Create Space',
        name: 'createSpace',
        description: 'Create a new space (reuses an existing space with the same name)'
    },
    {
        label: 'Update Space',
        name: 'updateSpace',
        description: 'Update mutable fields on a space (name, publicRead, labels)'
    },
    {
        label: 'Delete Space',
        name: 'deleteSpace',
        description: 'Permanently delete a space and all its memories'
    },
    {
        label: 'Create Memory',
        name: 'createMemory',
        description: 'Store text or a file as a new memory in a space'
    },
    {
        label: 'List Memories',
        name: 'listMemories',
        description: 'List memories in a space with optional pagination and filters'
    },
    {
        label: 'Get Memory',
        name: 'getMemory',
        description: 'Fetch a memory by ID, optionally including its original content'
    },
    {
        label: 'Retrieve Memories',
        name: 'retrieveMemories',
        description: 'Semantic similarity search across one or more spaces'
    },
    {
        label: 'Delete Memory',
        name: 'deleteMemory',
        description: 'Permanently delete a memory and its chunks/embeddings'
    }
]

const SELECT_ALL_NAME = '__all__'

// Flowise's form layer can serialize booleans as the string "true"/"false".
// Default to verify=true when unset; only flip to false when explicitly false.
const parseVerifySsl = (raw: unknown): boolean => {
    if (raw === undefined || raw === null) return true
    if (typeof raw === 'boolean') return raw
    return String(raw).toLowerCase() !== 'false'
}

class GoodMem_Tools implements INode {
    label: string
    name: string
    version: number
    type: string
    icon: string
    category: string
    description: string
    baseClasses: string[]
    credential: INodeParams
    inputs: INodeParams[]

    constructor() {
        this.label = 'GoodMem'
        this.name = 'goodMem'
        this.version = 1.0
        this.type = 'GoodMem'
        this.icon = 'goodmem.png'
        this.category = 'Tools'
        this.description = 'Memory layer for AI agents: semantic storage, retrieval, and summarization via GoodMem.'
        this.baseClasses = [this.type, 'Tool']
        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['goodMemApi']
        }
        this.inputs = [
            {
                label: 'Actions',
                name: 'actions',
                type: 'multiOptions',
                description:
                    'Choose which GoodMem operations to expose as tools. Leave empty to expose every operation supported by GoodMem.',
                options: [
                    { label: 'All Operations', name: SELECT_ALL_NAME },
                    ...ALL_ACTION_OPTIONS.map((a) => ({ label: a.label, name: a.name, description: a.description }))
                ],
                default: [SELECT_ALL_NAME]
            },
            {
                label: 'Default Embedder',
                name: 'defaultEmbedderId',
                type: 'asyncOptions',
                loadMethod: 'listEmbedders',
                description:
                    'Default embedder used when goodmem_create_space is called without an embedder_id. The list is pulled live from your GoodMem server.',
                optional: true,
                refresh: true
            },
            {
                label: 'Default Space',
                name: 'defaultSpaceId',
                type: 'asyncOptions',
                loadMethod: 'listSpaces',
                description:
                    'Default space used when goodmem_create_memory / goodmem_list_memories / goodmem_get_space / goodmem_retrieve_memories are called without an explicit space_id. Update and delete operations still require an explicit ID, so a misconfigured default cannot delete the wrong space. The list is pulled live from your GoodMem server.',
                optional: true,
                refresh: true
            }
        ]
    }

    loadMethods: Record<string, (_nodeData: INodeData, _options?: ICommonObject) => Promise<INodeOptionsValue[]>> = {
        listEmbedders: async (nodeData: INodeData, options?: ICommonObject): Promise<INodeOptionsValue[]> => {
            try {
                const credentialData = await getCredentialData(nodeData.credential ?? '', options ?? {})
                const baseUrl = getCredentialParam('goodMemBaseUrl', credentialData, nodeData)
                const apiKey = getCredentialParam('goodMemApiKey', credentialData, nodeData)
                const verifySsl = parseVerifySsl(getCredentialParam('goodMemVerifySsl', credentialData, nodeData))

                if (!baseUrl || !apiKey) {
                    return [
                        {
                            label: 'Credentials Required',
                            name: '',
                            description: 'Connect a GoodMem API credential to load embedders.'
                        }
                    ]
                }

                const client = new GoodMemClient({ baseUrl, apiKey, verifySsl })
                const embedders = await client.listEmbedders()
                if (!embedders.length) {
                    return [
                        {
                            label: 'No embedders found',
                            name: '',
                            description: 'No embedders are configured on this GoodMem server.'
                        }
                    ]
                }
                return embedders.map((e) => {
                    const id = (e as any).embedderId ?? (e as any).id ?? ''
                    const displayName = (e as any).displayName ?? (e as any).name ?? id
                    const providerType = (e as any).providerType ?? (e as any).provider ?? ''
                    return {
                        label: providerType ? `${displayName} (${providerType})` : displayName,
                        name: id,
                        description: id
                    }
                })
            } catch (error) {
                return [
                    {
                        label: 'Error Loading Embedders',
                        name: '',
                        description: `Failed to load embedders: ${error instanceof Error ? error.message : String(error)}`
                    }
                ]
            }
        },
        listSpaces: async (nodeData: INodeData, options?: ICommonObject): Promise<INodeOptionsValue[]> => {
            try {
                const credentialData = await getCredentialData(nodeData.credential ?? '', options ?? {})
                const baseUrl = getCredentialParam('goodMemBaseUrl', credentialData, nodeData)
                const apiKey = getCredentialParam('goodMemApiKey', credentialData, nodeData)
                const verifySsl = parseVerifySsl(getCredentialParam('goodMemVerifySsl', credentialData, nodeData))

                if (!baseUrl || !apiKey) {
                    return [
                        {
                            label: 'Credentials Required',
                            name: '',
                            description: 'Connect a GoodMem API credential to load spaces.'
                        }
                    ]
                }

                const client = new GoodMemClient({ baseUrl, apiKey, verifySsl })
                const spaces = await client.listSpaces()
                if (!spaces.length) {
                    return [
                        {
                            label: 'No spaces found',
                            name: '',
                            description:
                                'No spaces exist on this GoodMem server yet. The agent or another tool can create one with goodmem_create_space.'
                        }
                    ]
                }
                return spaces.map((s) => {
                    const id = (s as any).spaceId ?? (s as any).id ?? ''
                    const name = (s as any).name ?? id
                    return {
                        label: name,
                        name: id,
                        description: id
                    }
                })
            } catch (error) {
                return [
                    {
                        label: 'Error Loading Spaces',
                        name: '',
                        description: `Failed to load spaces: ${error instanceof Error ? error.message : String(error)}`
                    }
                ]
            }
        }
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const baseUrl = getCredentialParam('goodMemBaseUrl', credentialData, nodeData)
        const apiKey = getCredentialParam('goodMemApiKey', credentialData, nodeData)
        const verifySsl = parseVerifySsl(getCredentialParam('goodMemVerifySsl', credentialData, nodeData))

        if (!baseUrl) {
            throw new Error('GoodMem Base URL is required. Set it on the GoodMem API credential.')
        }
        if (!apiKey) {
            throw new Error('GoodMem API Key is required. Set it on the GoodMem API credential.')
        }

        const selected = convertMultiOptionsToStringArray(nodeData.inputs?.actions)
        const defaultEmbedderId = (nodeData.inputs?.defaultEmbedderId as string) || undefined
        const defaultSpaceId = (nodeData.inputs?.defaultSpaceId as string) || undefined

        let actions: string[]
        if (selected.length === 0 || selected.includes(SELECT_ALL_NAME)) {
            actions = [...GOODMEM_ACTIONS]
        } else {
            actions = selected.filter((a) => (GOODMEM_ACTIONS as readonly string[]).includes(a))
            if (actions.length === 0) {
                throw new Error(
                    `No valid GoodMem actions selected. Choose at least one of: ${(GOODMEM_ACTIONS as readonly string[]).join(', ')}.`
                )
            }
        }

        return createGoodMemTools({
            baseUrl,
            apiKey,
            verifySsl,
            actions,
            defaultEmbedderId,
            defaultSpaceId
        })
    }
}

module.exports = { nodeClass: GoodMem_Tools }
