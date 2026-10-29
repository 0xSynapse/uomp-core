import { Command } from 'commander';
import { createInterface } from 'readline';
import { UompConfig } from '../config.js';
import { loadSessionCredentials } from '../utils/session-env.js';

interface McpOptions {
  session?: string;
  baseUrl?: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: 'list_memory',
    description: 'List memory items authorized by the current UOMP session for a tag. Use this to discover keys before reading them.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: {
          type: 'string',
          description: 'Scope tag to list, for example notes/projects',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          default: 50,
        },
      },
      required: ['tag'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_memory',
    description: 'Read one memory item by key. UOMP scope, expiry, revocation, and audit still apply.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Memory key, for example note.projects.uomp.plan',
        },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
];

export class McpCommands {
  static get(): Command {
    return new Command('mcp')
      .description('Run a stdio MCP server for Claude Desktop / Cursor')
      .option('-s, --session <session>', 'Session ID or path to a session env file')
      .option('--base-url <url>', 'Override the UOMP server URL')
      .action(async (options: McpOptions) => {
        try {
          const config = new UompConfig();
          await new McpCommands(config).serve(options);
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
        }
      });
  }

  private config: UompConfig;

  constructor(config: UompConfig) {
    this.config = config;
  }

  async serve(options: McpOptions): Promise<void> {
    await this.config.init();

    const credentials = await loadSessionCredentials(this.config, options.session);
    if (!credentials) {
      throw new Error(
        'No UOMP session. Pass --session <id|env-file>, or set UOM_TOKEN and UOMP_BASE_URL.'
      );
    }

    const baseUrl = normalizeBaseUrl(options.baseUrl ?? credentials.baseUrl);
    await verifySession(baseUrl, credentials.token);
    process.stderr.write(`UOMP MCP server ready: ${baseUrl} (${credentials.source})\n`);

    await this.run(baseUrl, credentials.token);
  }

  private async run(baseUrl: string, token: string): Promise<void> {
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let queue = Promise.resolve();

    input.on('line', line => {
      if (!line.trim()) return;
      queue = queue
        .then(() => this.handleLine(line, baseUrl, token))
        .catch(error => {
          process.stderr.write(`UOMP MCP error: ${error instanceof Error ? error.message : String(error)}\n`);
        });
    });

    await new Promise<void>(resolve => {
      input.on('close', () => {
        void queue.finally(() => resolve());
      });
    });
  }

  private async handleLine(line: string, baseUrl: string, token: string): Promise<void> {
    let message: JsonRpcMessage;

    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      sendError(null, -32700, 'Parse error');
      return;
    }

    if (!message || typeof message !== 'object' || typeof message.method !== 'string') {
      return;
    }

    if (message.id === undefined || message.id === null) {
      // Client notification; no response is expected.
      return;
    }

    try {
      const result = await this.dispatch(message, baseUrl, token);
      sendResult(message.id, result);
    } catch (error) {
      if (error instanceof RpcError) {
        sendError(message.id, error.code, error.message);
      } else {
        sendError(message.id, -32603, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async dispatch(
    message: JsonRpcMessage,
    baseUrl: string,
    token: string
  ): Promise<unknown> {
    switch (message.method) {
      case 'initialize':
        return {
          protocolVersion: typeof message.params?.protocolVersion === 'string'
            ? message.params.protocolVersion
            : '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'uomp', version: '0.0.1' },
        };

      case 'ping':
        return {};

      case 'tools/list':
        return { tools: TOOLS };

      case 'tools/call':
        return this.callTool(message.params, baseUrl, token);

      default:
        throw new RpcError(-32601, `Method not found: ${message.method}`);
    }
  }

  private async callTool(
    params: Record<string, unknown> | undefined,
    baseUrl: string,
    token: string
  ): Promise<unknown> {
    const name = typeof params?.name === 'string' ? params.name : '';
    const args = (params?.arguments && typeof params.arguments === 'object')
      ? params.arguments as Record<string, unknown>
      : {};

    if (name === 'list_memory') {
      const tag = typeof args.tag === 'string' ? args.tag.trim() : '';
      if (!tag) {
        return toolError('The "tag" argument is required.');
      }

      const url = new URL(`${baseUrl}/v1/memory`);
      url.searchParams.set('tag', tag);
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await readJson(response);

      if (!response.ok) {
        return toolError(formatHttpError(response, body));
      }

      const items = Array.isArray(body?.items) ? body.items : [];
      const limit = clampLimit(args.limit);
      return toolResult(JSON.stringify({
        count: items.length,
        items: items.slice(0, limit),
      }, null, 2));
    }

    if (name === 'read_memory') {
      const key = typeof args.key === 'string' ? args.key.trim() : '';
      if (!key) {
        return toolError('The "key" argument is required.');
      }

      const response = await fetch(`${baseUrl}/v1/memory/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await readJson(response);

      if (!response.ok) {
        return toolError(formatHttpError(response, body));
      }

      return toolResult(JSON.stringify(body, null, 2));
    }

    throw new RpcError(-32602, `Unknown tool: ${name || '(missing)'}`);
  }
}

class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

async function verifySession(baseUrl: string, token: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/audit?limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new Error(`Cannot reach UOMP at ${baseUrl}. Start it with: uomp serve`);
  }

  if (!response.ok) {
    const body = await readJson(response);
    const reason = body?.error?.message ?? response.statusText;
    throw new Error(
      `UOMP session is not active (${response.status}): ${reason}. ` +
      'Run `uomp authorize <agent>` again to create a new session.'
    );
  }
}

function normalizeBaseUrl(value: string): string {
  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  return withScheme.replace(/\/+$/, '');
}

async function readJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function formatHttpError(response: Response, body: any): string {
  const code = body?.error?.code;
  const message = body?.error?.message ?? response.statusText;
  return code ? `${code}: ${message}` : message;
}

function clampLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 50;
  }

  return Math.min(100, Math.max(1, Math.floor(value)));
}

function toolResult(text: string): unknown {
  return {
    content: [{ type: 'text', text }],
    isError: false,
  };
}

function toolError(text: string): unknown {
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

function sendResult(id: string | number | null, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function sendError(id: string | number | null, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}
