import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';
import { chmod, mkdir, rename, rm, writeFile } from 'fs/promises';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { UompConfig } from '../config.js';
import { MemoryStore } from '@uomp/store';
import { IdentityVerifier } from '@uomp/identity';
import { loadManifest } from '../utils/manifest.js';
import type { AgentManifest, ScopeAction, Scopes } from '@uomp/core';
import { buildReadScope, inferSensitivity, normalizeManifest } from '@uomp/core';
import {
  createUompRuntime,
  installShutdownHandlers,
  isLoopbackHost,
  startUompServer,
  type ServerStartResult,
  type UompRuntime,
} from '../utils/server.js';
import { formatDateTime, formatScopes, sanitizeText } from '../utils/format.js';

export interface AuthorizeOptions {
  scope?: string[];
  output?: string;
  duration?: string;
  server?: boolean;
  printToken?: boolean;
}

export class AuthorizeCommands {
  private config: UompConfig;

  constructor(config: UompConfig) {
    this.config = config;
  }

  async authorize(agentPath: string | undefined, options: AuthorizeOptions): Promise<void> {
    const durationMinutes = parseDuration(options.duration);
    await this.config.init();

    const resolvedPath = agentPath ? resolve(agentPath) : undefined;
    let manifest: AgentManifest;

    if (resolvedPath) {
      const loaded = await loadManifest(resolvedPath);
      if (!loaded) {
        throw new Error(`Could not find uom.json in ${resolvedPath}`);
      }
      manifest = loaded;
    } else {
      if (!options.scope || options.scope.length === 0) {
        throw new Error('Pass --scope when authorizing a generic MCP client, or provide an agent path.');
      }
      manifest = genericMcpManifest();
    }

    const verification = await new IdentityVerifier().verifyManifest(manifest);
    const identity = verification.valid
      ? chalk.green(`verified via ${verification.method}`)
      : manifest.identity
        ? chalk.yellow(`unverified (${sanitizeText(verification.error ?? 'unknown error')})`)
        : chalk.gray('unsigned (no identity proof)');

    const grantedScopes = options.scope && options.scope.length > 0
      ? this.buildScopesFromTags(manifest, options.scope)
      : await this.promptForScopes(manifest, []);

    const runtime = await createUompRuntime(this.config);
    const session = runtime.auth.createSession({
      agent_id: manifest.agent.id,
      agent_name: manifest.agent.name,
      requested_scopes: manifest.requestedScopes,
      duration_minutes: durationMinutes,
    });

    const grant = await runtime.auth.grantSession(session.sessionId, grantedScopes);
    if (!grant) {
      runtime.close();
      throw new Error('Failed to grant session');
    }

    const envPath = options.output
      ? resolve(options.output)
      : join(this.config.sessionsDir, `${session.sessionId}.env`);

    try {
      await this.writeSessionEnv(envPath, session.sessionId, manifest.agent.id, grant.expiresAt, grant.token);
    } catch (error) {
      await this.abortSession(runtime, session.sessionId);
      throw error;
    }

    const printSummary = () => this.printSummary({
      manifest,
      ...(resolvedPath ? { agentPath: resolvedPath } : {}),
      sessionId: session.sessionId,
      expiresAt: grant.expiresAt,
      durationMinutes,
      scopes: grantedScopes,
      identity,
      envPath,
      token: grant.token,
      printToken: options.printToken === true,
    });

    if (options.server === false) {
      printSummary();
      runtime.close();
      console.log('');
      console.log(chalk.gray('Server not started (--no-server).'));
      console.log(chalk.gray('Start it when the Agent is ready: uomp serve'));
      return;
    }

    let server: ServerStartResult;
    try {
      server = await startUompServer(runtime);
    } catch (error) {
      await this.abortSession(runtime, session.sessionId, envPath);
      throw error;
    }

    if (server.status === 'in-use') {
      if (!server.isUomp) {
        await this.abortSession(runtime, session.sessionId, envPath);
        throw new Error(
          `Port ${this.config.port} is in use by another process. The session was revoked. ` +
          `Stop it, then run \`uomp serve --port ${this.config.port}\` and authorize again.`
        );
      }

      printSummary();
      runtime.close();
      console.log('');
      console.log(chalk.gray(`A UOMP server is already running on ${server.url}.`));
      return;
    }

    printSummary();
    console.log('');
    console.log(chalk.green(`UOMP server listening on ${server.url}`));
    if (!isLoopbackHost(this.config.host)) {
      console.log(chalk.yellow(`Warning: ${this.config.host} exposes the UOMP server beyond localhost.`));
    }
    console.log(chalk.gray('Keep this terminal open. Press Ctrl+C to stop.'));
    installShutdownHandlers(() => server.close());
  }

  private async promptForScopes(manifest: AgentManifest, additionalScopes: string[]): Promise<Scopes> {
    const readTags = [
      ...new Set([
        ...(manifest.requestedScopes.read.tags ?? []),
        ...additionalScopes,
      ]),
    ];

    if (readTags.length === 0) {
      return emptyScopes();
    }

    console.log(chalk.bold(`\nAgent "${sanitizeText(manifest.agent.name)}" requests access to:`));
    console.log(`  Publisher: ${sanitizeText(manifest.agent.publisher ?? 'Unknown')}`);
    console.log(`  ${sanitizeText(manifest.agent.description ?? 'No description')}`);

    for (const tag of readTags) {
      const sensitivity = inferSensitivity(tag);
      const levelLabel = sensitivity === 'high'
        ? chalk.red('high')
        : sensitivity === 'medium'
          ? chalk.yellow('medium')
          : chalk.green('low');
      console.log(`  [${levelLabel}] ${sanitizeText(tag)}`);

      if (sensitivity === 'high') {
        const fields = manifest.requestedScopes.read.fields?.[tag];
        const purpose = manifest.requestedScopes.read.purposes?.[tag];
        if (fields && fields.length > 0) {
          console.log(`      Fields: ${fields.join(', ')}`);
        }
        if (purpose) {
          console.log(`      Purpose: ${purpose}`);
        }
      }
    }

    const { selectedTags } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'selectedTags',
        message: 'Select tags to authorize for reading:',
        choices: readTags,
        default: manifest.requestedScopes.read.tags,
      },
    ]);

    const readScope: ScopeAction = buildReadScope(manifest.requestedScopes.read, selectedTags as string[]);
    this.addHighSensitivityKeys(readScope, selectedTags as string[]);

    return {
      read: readScope,
      write: emptyScopes().write,
    };
  }

  private buildScopesFromTags(manifest: AgentManifest, tags: string[]): Scopes {
    const readScope: ScopeAction = buildReadScope(manifest.requestedScopes.read, tags);
    this.addHighSensitivityKeys(readScope, tags);
    return {
      read: readScope,
      write: emptyScopes().write,
    };
  }

  private addHighSensitivityKeys(scope: ScopeAction, tags: string[]): void {
    if (!tags.some(tag => inferSensitivity(tag) === 'high')) {
      return;
    }

    // High sensitivity items cannot be authorized by tag alone; explicitly include their keys.
    const store = new MemoryStore({ dbPath: this.config.memoryDbPath });
    try {
      for (const tag of tags) {
        if (inferSensitivity(tag) !== 'high') continue;
        for (const item of store.getByTag(tag)) {
          if (!scope.keys.includes(item.key)) {
            scope.keys.push(item.key);
          }
        }
      }
    } finally {
      store.close();
    }
  }

  private async abortSession(runtime: UompRuntime, sessionId: string, envPath?: string): Promise<void> {
    try {
      runtime.auth.revokeSession(sessionId);
    } catch {
      // Keep the original error; the session will expire on its own.
    }
    runtime.close();

    if (!envPath) return;

    try {
      await rm(envPath, { force: true });
    } catch {
      // The env file may not exist yet.
    }
  }

  private async writeSessionEnv(
    envPath: string,
    sessionId: string,
    agentId: string,
    expiresAt: string,
    token: string
  ): Promise<void> {
    await mkdir(dirname(envPath), { recursive: true, mode: 0o700 });
    const envBlock = [
      `# UOMP session ${sanitizeText(sessionId)}`,
      `# agent: ${sanitizeText(agentId)}`,
      `# expires: ${sanitizeText(expiresAt)}`,
      `export UOM_TOKEN=${shellQuote(token)}`,
      `export UOMP_BASE_URL=${shellQuote(this.config.serverUrl)}`,
      '',
    ].join('\n');

    const tempPath = `${envPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tempPath, envBlock, { mode: 0o600, flag: 'wx' });
      await chmod(tempPath, 0o600);
      await rename(tempPath, envPath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  private printSummary(input: {
    manifest: AgentManifest;
    agentPath?: string;
    sessionId: string;
    expiresAt: string;
    durationMinutes: number;
    scopes: Scopes;
    identity: string;
    envPath: string;
    token: string;
    printToken: boolean;
  }): void {
    const { manifest, agentPath, sessionId, expiresAt, durationMinutes, scopes, envPath } = input;

    console.log(chalk.green(`Session granted: ${sessionId}`));
    console.log(`  Agent     ${sanitizeText(manifest.agent.name)} (${sanitizeText(manifest.agent.id)})`);
    console.log(`  Scope     ${formatScopes(scopes)}`);
    console.log(`  Expires   ${formatDateTime(expiresAt)} (${durationMinutes} min)`);
    console.log(`  Identity  ${input.identity}`);
    console.log('');

    console.log(chalk.bold('Env file'));
    console.log(`  ${envPath}`);
    console.log('');
    console.log(chalk.bold('Open a new terminal, then:'));
    console.log(`  source ${shellQuote(envPath)}`);
    const entryPoint = agentPath ? join(agentPath, 'index.js') : null;
    if (entryPoint && existsSync(entryPoint)) {
      console.log(chalk.gray(`  node ${shellQuote(entryPoint)}   # example`));
    }

    if (input.printToken) {
      console.log('');
      console.log(chalk.bold('Token'));
      console.log(`  export UOM_TOKEN="${input.token}"`);
    }

    console.log('');
    console.log(`Revoke with: ${chalk.cyan(`uomp revoke ${sessionId}`)}`);
  }
}

function emptyScopes(): Scopes {
  return {
    read: { tags: [], keys: [], denyTags: [], denyKeys: [] },
    write: { tags: [], keys: [], denyTags: [], denyKeys: [] },
  };
}

function genericMcpManifest(): AgentManifest {
  return normalizeManifest({
    uomp_version: '1.0',
    agent: {
      id: 'mcp-client',
      name: 'MCP Client',
      version: '0.1.0',
      description: 'Generic MCP client',
      publisher: 'uomp',
    },
    requested_scopes: {
      read: { tags: [], keys: [], deny_tags: [], deny_keys: [] },
      write: { tags: [], keys: [], deny_tags: [], deny_keys: [] },
    },
  });
}

function parseDuration(value?: string): number {
  const raw = (value ?? '30').trim();
  const minutes = Number(raw);

  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new Error(`Invalid duration "${raw}". Use whole minutes between 1 and 1440.`);
  }

  return minutes;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
