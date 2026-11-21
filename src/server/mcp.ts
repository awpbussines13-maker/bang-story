import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerAgentTools } from './agentTools'

export function createBangStoryMcp(options: { token: string; port: number; publicOrigin: string }): McpServer {
  const server = new McpServer({ name: 'bang-story', version: '1.0.0' }, { maxToolInputElements: 20000 })
  registerAgentTools(server, options)
  return server
}
