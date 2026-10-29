import { Command } from 'commander';
import { createInterface } from 'readline';
import { UompConfig } from '../config.js';
import { loadSessionCredentials, type SessionCredentials } from '../utils/session-env.js';
import { parseMcpClient, printClientConfig } from '../utils/mcp-config.js';

interface McpOptions {
  session?: string;
  baseUrl?: string;
  printConfig?: boolean;
  client?: string;
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
    description: 'List keys and metadata authorized by the current UOMP session for a tag. Content is not included; use read_memory for a specific key.',
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
    name: 'search_memory',
    description: 'Search authorized memory items for a tag by text. Returns keys and metadata only; use read_memory for content.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: {
          type: 'string',
          description: 'Scope tag to search, for example notes/projects',
        },
        query: {
          type: 'string',
          description: 'Text to match against key, title, path, description, tags, or content',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          default: 20,
        },
      },
      required: ['tag', 'query'],
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
      .option('--print-config', 'Print an MCP client config and exit')
      .option('--client <client>', 'Config preset: claude, cursor, or opencode')
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
  private sessionInput?: string;
  private baseUrlOverride?: string;
  private credentials!: SessionCredentials;

  constructor(config: UompConfig) {
    this.config = config;
  }

  async serve(options: McpOptions): Promise<void> {
    this.sessionInput = options.session;
    this.baseUrlOverride = options.baseUrl;

    const credentials = await loadSessionCredentials(this.config, options.session);
    if (!credentials) {
      throw new Error(
        'No UOMP session. Pass --session <id|env-file>, or set UOM_TOKEN and UOMP_BASE_URL.'
      );
    }

    this.credentials = credentials;

    const client = parseMcpClient(options.client);
    if (client !== 'generic' && !options.printConfig) {
      throw new Error('--client requires --print-config.');
    }

    if (options.printConfig) {
      printClientConfig(client, credentials.source);
      return;
    }

    try {
      await verifySession(this.connectionUrl(), credentials.token);
    } catch (error) {
      process.stderr.write(
        `UOMP MCP warning: ${error instanceof Error ? error.message : String(error)}\n` +
        'The server will re-read the session file on the next tool call.\n'
      );
    }

    process.stderr.write(`UOMP MCP server ready: ${this.connectionUrl()} (${credentials.source})\n`);

    await this.run();
  }

  private connectionUrl(): string {
    return normalizeBaseUrl(this.baseUrlOverride ?? this.credentials.baseUrl);
  }

  private async refreshCredentials(): Promise<void> {
    if (!this.sessionInput) return;

    try {
      const next = await loadSessionCredentials(this.config, this.sessionInput);
      if (next) this.credentials = next;
    } catch {
      // Keep the current credentials; the tool call will report the auth error.
    }
  }

  private async run(): Promise<void> {
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let queue = Promise.resolve();

    input.on('line', line => {
      if (!line.trim()) return;
      queue = queue
        .then(() => this.handleLine(line))
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

  private async handleLine(line: string): Promise<void> {
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
      await this.refreshCredentials();
      const result = await this.dispatch(message);
      sendResult(message.id, result);
    } catch (error) {
      if (error instanceof RpcError) {
        sendError(message.id, error.code, error.message);
      } else {
        sendError(message.id, -32603, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async dispatch(message: JsonRpcMessage): Promise<unknown> {
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
        return this.callTool(message.params);

      default:
        throw new RpcError(-32601, `Method not found: ${message.method}`);
    }
  }

  private async callTool(params: Record<string, unknown> | undefined): Promise<unknown> {
    const name = typeof params?.name === 'string' ? params.name : '';
    const args = (params?.arguments && typeof params.arguments === 'object')
      ? params.arguments as Record<string, unknown>
      : {};
    const baseUrl = this.connectionUrl();
    const token = this.credentials.token;

    if (name === 'list_memory') {
      const tag = typeof args.tag === 'string' ? args.tag.trim() : '';
      if (!tag) {
        return toolError('The "tag" argument is required.');
      }

      const result = await fetchItemsByTag(baseUrl, token, tag);
      if (!result.items) {
        return toolError(result.error ?? 'Request failed.');
      }

      const limit = clampLimit(args.limit);
      return toolResult(JSON.stringify({
        count: result.items.length,
        items: result.items.slice(0, limit).map(summarizeItem),
      }, null, 2));
    }

    if (name === 'search_memory') {
      const tag = typeof args.tag === 'string' ? args.tag.trim() : '';
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!tag || !query) {
        return toolError('The "tag" and "query" arguments are required.');
      }

      const result = await fetchItemsByTag(baseUrl, token, tag);
      if (!result.items) {
        return toolError(result.error ?? 'Request failed.');
      }

      const needle = query.toLowerCase();
      const matches = result.items.filter(item => searchableText(item).includes(needle));
      const limit = clampLimit(args.limit, 20);
      return toolResult(JSON.stringify({
        count: matches.length,
        query,
        items: matches.slice(0, limit).map(summarizeItem),
      }, null, 2));
    }

    if (name === 'read_memory') {
      const key = typeof args.key === 'string' ? args.key.trim() : '';
      if (!key) {
        return toolError('The "key" argument is required.');
      }

      const response = await requestJson(`${baseUrl}/v1/memory/${encodeURIComponent(key)}`, token);
      if (!response.response) {
        return toolError(response.error ?? 'Request failed.');
      }
      if (!response.response.ok) {
        return toolError(formatHttpError(response.response, response.body));
      }

      return toolResult(JSON.stringify(response.body, null, 2));
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

async function fetchItemsByTag(
  baseUrl: string,
  token: string,
  tag: string
): Promise<{ items?: any[]; error?: string }> {
  const url = new URL(`${baseUrl}/v1/memory`);
  url.searchParams.set('tag', tag);

  const result = await requestJson(url, token);
  if (!result.response) {
    return { error: result.error };
  }
  if (!result.response.ok) {
    return { error: formatHttpError(result.response, result.body) };
  }

  return { items: Array.isArray(result.body?.items) ? result.body.items : [] };
}

async function requestJson(
  input: string | URL,
  token: string
): Promise<{ response?: Response; body?: any; error?: string }> {
  try {
    const response = await fetch(input, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { response, body: await readJson(response) };
  } catch {
    return { error: `Cannot reach UOMP at ${String(input)}. Start it with: uomp serve` };
  }
}

function summarizeItem(item: any): Record<string, unknown> {
  const value = item?.value ?? {};
  return {
    key: item?.key,
    title: value.title,
    path: value.path,
    tags: item?.tags,
    sensitivity: item?.sensitivity,
    description: item?.description,
    updated_at: item?.updated_at,
  };
}

function searchableText(item: any): string {
  const value = item?.value ?? {};
  return [
    item?.key,
    item?.description,
    ...(Array.isArray(item?.tags) ? item.tags : []),
    value.title,
    value.path,
    value.content,
  ]
    .filter(value => typeof value === 'string')
    .join('\n')
    .toLowerCase();
}

function formatHttpError(response: Response, body: any): string {
  const code = body?.error?.code;
  const message = body?.error?.message ?? response.statusText;
  return code ? `${code}: ${message}` : message;
}

function clampLimit(value: unknown, fallback = 50): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
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
