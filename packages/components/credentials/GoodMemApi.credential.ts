import { INodeParams, INodeCredential } from '../src/Interface'

class GoodMemApi implements INodeCredential {
    label: string
    name: string
    version: number
    description: string
    inputs: INodeParams[]

    constructor() {
        this.label = 'GoodMem API'
        this.name = 'goodMemApi'
        this.version = 1.0
        this.description =
            'GoodMem connection details. Visit <a target="_blank" href="https://goodmem.ai">goodmem.ai</a> to provision an API key. Base URL example: <code>https://localhost:8080</code>'
        this.inputs = [
            {
                label: 'Base URL',
                name: 'goodMemBaseUrl',
                type: 'string',
                description: 'Base URL of the GoodMem API server',
                placeholder: 'https://localhost:8080'
            },
            {
                label: 'API Key',
                name: 'goodMemApiKey',
                type: 'password',
                description: 'API key issued by GoodMem (sent as X-API-Key header)'
            },
            {
                label: 'Verify SSL',
                name: 'goodMemVerifySsl',
                type: 'boolean',
                description: 'Verify the server TLS certificate. Disable only for self-signed local installs.',
                default: true,
                optional: true
            }
        ]
    }
}

module.exports = { credClass: GoodMemApi }
