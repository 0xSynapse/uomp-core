import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { UompConfig } from '../config.js';
import { AuthorizeCommands } from './authorize.js';
import { isConnectClient, type ConnectClient } from '../utils/mcp-config.js';
import { parseHost, parsePort } from '../utils/server.js';
import { MemoryStore } from '@uomp/store';
import { importMarkdown } from '../utils/markdown.js';
import { printMarkdownImportResult } from '../utils/import-output.js';

interface ConnectOptions {
  scope?: string[];
  allowKey?: string[];
  allowHigh?: string[];
  output?: string;
  duration?: string;
  port?: string;
  host?: string;
  server?: boolean;
  foreground?: boolean;
  printConfig?: boolean;
  skipConfig?: boolean;
  config?: string;
  printToken?: boolean;
  vault?: string;
  vaultTag?: string;
}

export class ConnectCommands {
  static get(): Command {
    return new Command('connect')
      .description('Connect an MCP client or agent package and grant a scoped session')
      .argument('<target>', 'claude, cursor, opencode, or a path to an agent package')
      .option('-s, --scope <scopes...>', 'Read tags to grant; high-sensitivity keys still need explicit approval')
      .option('--allow-key <keys...>', 'Explicitly allow high-sensitivity keys (use with --scope)')
      .option('--allow-high <tags...>', 'Explicitly allow all keys under named high-sensitivity tags')
      .option('-d, --duration <minutes>', 'Session duration in minutes (1-1440)', '30')
      .option('-o, --output <file>', 'Write the session env file to a custom path')
      .option('-p, --port <port>', 'Local server port (default: 9374)')
      .option('--host <host>', 'Local server host (default: 127.0.0.1)')
      .option('--no-server', 'Do not start the local Auth + Guard server')
      .option('--foreground', 'Keep the local server in this terminal instead of the background')
      .option('--print-config', 'Grant a session, print the MCP client config, and exit without writing the client config')
      .option('--skip-config', 'Do not write the MCP client config')
      .option('--config <file>', 'Write the MCP client config to a custom path')
      .option('--vault <path>', 'Import a Markdown vault or file before connecting')
      .option('--vault-tag <tag>', 'Base tag for --vault imports', 'notes')
      .option('--print-token', 'Print the capability token')
      .action(async (target: string, options: ConnectOptions) => {
        try {
          const resolved = resolveTarget(target);

          if (!resolved.client && options.config) {
            throw new Error('--config is only valid for Claude Desktop, Cursor, or OpenCode.');
          }

          const config = new UompConfig({
            port: options.port ? parsePort(options.port) : undefined,
            host: options.host ? parseHost(options.host) : undefined,
          });

          if (options.vault) {
            await importVault(config, options.vault, options.vaultTag ?? 'notes');
          }

          const authorizer = new AuthorizeCommands(config);
          await authorizer.authorize(resolved.agentPath, {
            ...(options.scope ? { scope: options.scope } : {}),
            ...(options.allowKey ? { allowKeys: options.allowKey } : {}),
            ...(options.allowHigh ? { allowHigh: options.allowHigh } : {}),
            ...(options.output ? { output: options.output } : {}),
            ...(options.duration ? { duration: options.duration } : {}),
            ...(options.server === false ? { server: false } : {}),
            ...(options.foreground ? {} : { background: true }),
            ...(options.printToken ? { printToken: true } : {}),
            ...(resolved.client ? { client: resolved.client } : {}),
            ...(options.config ? { configPath: options.config } : {}),
            ...(options.printConfig ? { printConfig: true } : {}),
            ...(options.skipConfig ? { writeConfig: false } : {}),
          });
        } catch (error) {
          console.error(chalk.red(error instanceof Error ? error.message : String(error)));
          process.exitCode = 1;
        }
      });
  }
}

async function importVault(config: UompConfig, target: string, tag: string): Promise<void> {
  await config.init();

  const store = new MemoryStore({ dbPath: config.memoryDbPath });
  try {
    const result = await importMarkdown(store, target, { tag });
    printMarkdownImportResult(result);

    if (result.notes.length === 0) {
      throw new Error(`No Markdown notes found under ${target}.`);
    }
  } finally {
    store.close();
  }
}

function resolveTarget(target: string): { client?: ConnectClient; agentPath?: string } {
  const candidate = resolve(target);

  if (existsSync(join(candidate, 'uom.json'))) {
    return { agentPath: candidate };
  }

  const normalized = target.toLowerCase();
  if (isConnectClient(normalized)) {
    return { client: normalized };
  }

  throw new Error(
    `Unknown target "${target}". Use claude, cursor, opencode, or a path that contains uom.json.`
  );
}
