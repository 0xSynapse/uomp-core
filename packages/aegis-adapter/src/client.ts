import type {
  AegisLease,
  AegisMemoryDecision,
  AegisPolicyClient,
  MemoryAction,
} from './types.js';

export interface HttpAegisMcpClientOptions {
  /** Aegis daemon MCP endpoint, e.g. http://127.0.0.1:7080/mcp */
  endpoint: string;
  /** Operator token or tenant API key accepted by the Aegis daemon. */
  token: string;
  orgId: string;
  agentId: string;
  fetchImpl?: typeof fetch;
}

/**
 * Minimal JSON-RPC client for the Aegis MCP gateway.
 *
 * `approveEscalation` uses the human-only `policy_approve_escalation` tool and
 * must only be called by the trusted local approval surface.
 */
export class HttpAegisMcpClient implements AegisPolicyClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly orgId: string;
  private readonly agentId: string;
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;

  constructor(options: HttpAegisMcpClientOptions) {
    this.endpoint = options.endpoint;
    this.token = options.token;
    this.orgId = options.orgId;
    this.agentId = options.agentId;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async evaluate(action: MemoryAction, resource: string): Promise<AegisMemoryDecision> {
    const result = await this.callTool('memory_policy_evaluate', { action, resource });
    return parseDecision(result, action, resource);
  }

  async approveEscalation(escalationId: string, ttlSecs: number): Promise<AegisLease> {
    const result = await this.callTool('policy_approve_escalation', {
      escalation_id: escalationId,
      ttl_secs: ttlSecs,
    });
    return parseLease(result);
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
        'x-aegis-org': this.orgId,
        'x-aegis-agent': this.agentId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });

    if (!response.ok) {
      throw new Error(`Aegis MCP request failed (${response.status}): ${await response.text()}`);
    }

    const body = await response.json() as {
      error?: { message?: string };
      result?: {
        isError?: boolean;
        content?: Array<{ type?: string; text?: string }>;
      };
    };

    if (body.error) {
      throw new Error(body.error.message ?? 'Aegis MCP error');
    }

    const text = body.result?.content?.find((item) => item.type === 'text')?.text;
    if (body.result?.isError) {
      throw new Error(text ?? 'Aegis MCP tool error');
    }
    if (typeof text !== 'string') {
      throw new Error('Aegis MCP response did not contain text content');
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

function parseDecision(
  value: unknown,
  action: MemoryAction,
  resource: string,
): AegisMemoryDecision {
  if (!value || typeof value !== 'object') {
    throw new Error('Aegis memory decision was not an object');
  }
  const decision = value as Partial<AegisMemoryDecision>;
  if (decision.decision !== 'allow' && decision.decision !== 'ask' && decision.decision !== 'deny') {
    throw new Error(`Aegis returned an unknown memory decision: ${String(decision.decision)}`);
  }
  return {
    protocol: 'uomp',
    decision: decision.decision,
    action: decision.action ?? action,
    resource: decision.resource ?? resource,
    ...(decision.escalation_id ? { escalation_id: decision.escalation_id } : {}),
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(decision.matched_rule ? { matched_rule: decision.matched_rule } : {}),
    ...(decision.suggested_lease_scope
      ? { suggested_lease_scope: decision.suggested_lease_scope }
      : {}),
  };
}

function parseLease(value: unknown): AegisLease {
  if (!value || typeof value !== 'object') {
    throw new Error('Aegis lease was not an object');
  }
  const lease = value as Partial<AegisLease>;
  if (!lease.lease_id || !lease.action_pattern || !lease.resource_pattern) {
    throw new Error('Aegis lease is missing required fields');
  }
  return lease as AegisLease;
}
