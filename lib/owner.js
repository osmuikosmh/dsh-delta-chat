import { AgentBridge } from './agent-bridge.js'

/**
 * The owner's Delta Chat window gets a dedicated agent with the full tool
 * surface (danger-full-access) - the owner is trusted, so his commands run
 * unconditionally.
 */
export class OwnerAgentBridge extends AgentBridge {
  constructor(ctx, options = {}) {
    super(ctx, {
      ...options,
      sessionPrefix: 'delta-chat-owner',
      permissions: 'danger-full-access',
    })
  }
}
