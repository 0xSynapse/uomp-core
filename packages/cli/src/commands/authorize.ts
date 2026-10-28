import { resolve } from 'path';
import net from 'net';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { serve } from '@hono/node-server';
import { UompConfig } from '../config.js';
import { AuthService } from '@uomp/auth';
import { MemoryGuard } from '@uomp/guard';
import { MemoryStore } from '@uomp/store';
import { JWTTokenIssuer } from '@uomp/token';
import { IdentityVerifier } from '@uomp/identity';
import { loadManifest } from '../utils/manifest.js';
import type { AgentManifest, ScopeAction, Scopes } from '@uomp/core';
import { buildReadScope, inferSensitivity } from '@uomp/core';
import { writeFile } from 'fs/promises';

export class AuthorizeCommands {
  private config: UompConfig;
  private issuer: JWTTokenIssuer;
  private authService: AuthService;
  private guard: MemoryGuard;
  private store: MemoryStore;

  constructor(config: UompConfig) {
    this.config = config;
    this.issuer = new JWTTokenIssuer();
    this.authService = new AuthService({
      dbPath: config.authDbPath,
      issuer: this.issuer,
      adminToken: config.adminToken,
    });
    this.guard = new MemoryGuard({
      dbPath: config.auditDbPath,
      memoryDbPath: config.memoryDbPath,
      issuer: this.issuer,
      sessionStateProvider: this.authService,
    });
    this.store = new MemoryStore({ dbPath: config.memoryDbPath });
  }

  async ensureKeyPair(): Promise<void> {
    await this.issuer.loadOrGenerateKey(this.config.secretsDir);
  }

  async authorize(agentPath: string, options: { scope?: string[]; output?: string; duration?: string; server?: boolean }): Promise<void> {
    await this.ensureKeyPair();

    const resolvedPath = resolve(agentPath);
    const manifest = await loadManifest(resolvedPath);

    if (!manifest) {
      console.log(chalk.red(`Could not find uom.json in ${resolvedPath}`));
      return;
    }

    // Verify identity
    const verifier = new IdentityVerifier();
    const verification = await verifier.verifyManifest(manifest);
    if (!verification.valid) {
      console.log(chalk.yellow(`Identity verification warning: ${verification.error}`));
    } else {
      console.log(chalk.green(`Identity verified via ${verification.method}`));
    }

    // Show authorization panel with field-level summary
    // If scopes are provided via CLI, use them directly (non-interactive mode).
    const grantedScopes = options.scope && options.scope.length > 0
      ? this.buildScopesFromTags(manifest, options.scope)
      : await this.promptForScopes(manifest, []);

    // Create session
    const durationMinutes = options.duration ? parseInt(options.duration, 10) : 30;
    // Close Memory Store once keys have been collected
    this.store.close();

    const session = this.authService.createSession({
      agent_id: manifest.agent.id,
      agent_name: manifest.agent.name,
      requested_scopes: manifest.requestedScopes,
      duration_minutes: durationMinutes,
    });

    const grant = await this.authService.grantSession(session.sessionId, grantedScopes);
    if (!grant) {
      console.log(chalk.red('Failed to grant session'));
      return;
    }

    console.log(chalk.green(`Session granted: ${session.sessionId}`));
    console.log(chalk.gray(`Token expires at: ${grant.expiresAt}`));
    console.log('');

    const envBlock = [
      `export UOM_TOKEN="${grant.token}"`,
      `export UOMP_BASE_URL="${this.config.serverUrl}"`,
    ].join('\n');

    if (options.output) {
      await writeFile(options.output, envBlock + '\n', 'utf-8');
      console.log(chalk.cyan(`Token saved to: ${options.output}`));
      console.log(chalk.gray(`Run: source ${options.output}`));
    } else {
      console.log(chalk.cyan('Set the following environment variables in the terminal where you run the Agent:'));
      console.log(envBlock.split('\n').map(line => `  ${line}`).join('\n'));
    }

    console.log('');
    console.log(chalk.gray('Then start the Agent independently. Example:'));
    console.log(chalk.gray(`  node ${resolvedPath}/index.js`));
    console.log('');
    console.log(chalk.gray(`To revoke: uomp revoke ${session.sessionId}`));

    // Start Auth + Guard server so the Agent can connect unless disabled
    if (options.server !== false) {
      await this.startServer();
    }
  }

  private async promptForScopes(manifest: AgentManifest, additionalScopes: string[]): Promise<Scopes> {
    const readTags = [
      ...new Set([
        ...(manifest.requestedScopes.read.tags ?? []),
        ...additionalScopes,
      ]),
    ];

    if (readTags.length === 0) {
      return {
        read: { tags: [], keys: [], denyTags: [], denyKeys: [] },
        write: { tags: [], keys: [], denyTags: [], denyKeys: [] },
      };
    }

    console.log(chalk.bold(`\nAgent "${manifest.agent.name}" requests access to:`));
    console.log(`Description: ${manifest.agent.description ?? 'No description'}`);
    console.log(`Publisher: ${manifest.agent.publisher ?? 'Unknown'}`);

    // Tag-level exposure summary
    for (const tag of readTags) {
      const sensitivity = inferSensitivity(tag);
      const levelLabel = sensitivity === 'high' ? chalk.red('high') : sensitivity === 'medium' ? chalk.yellow('medium') : chalk.green('low');
      console.log(`  [${levelLabel}] ${tag}`);

      // Field-level summary for high sensitivity tags
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

    // Build final read scope
    const readScope: ScopeAction = buildReadScope(manifest.requestedScopes.read, selectedTags as string[]);

    // High sensitivity items require key-level authorization
    this.addHighSensitivityKeys(readScope, selectedTags as string[]);

    return {
      read: readScope,
      write: {
        tags: [],
        keys: [],
        denyTags: [],
        denyKeys: [],
      },
    };
  }

  private buildScopesFromTags(manifest: AgentManifest, tags: string[]): Scopes {
    const readScope: ScopeAction = buildReadScope(manifest.requestedScopes.read, tags);
    this.addHighSensitivityKeys(readScope, tags);
    return {
      read: readScope,
      write: {
        tags: [],
        keys: [],
        denyTags: [],
        denyKeys: [],
      },
    };
  }

  private addHighSensitivityKeys(scope: ScopeAction, tags: string[]): void {
    // High sensitivity items cannot be authorized by tag alone; explicitly include their keys.
    for (const tag of tags) {
      if (inferSensitivity(tag) === 'high') {
        const items = this.store.getByTag(tag);
        for (const item of items) {
          if (!scope.keys.includes(item.key)) {
            scope.keys.push(item.key);
          }
        }
      }
    }
  }


  private async startServer(): Promise<void> {
    const isAvailable = await this.isPortAvailable(this.config.port, this.config.host);
    if (!isAvailable) {
      console.log(chalk.yellow(`A server is already listening on ${this.config.serverUrl}.`));
      console.log(chalk.gray('Skipping embedded server startup; the Agent can use the existing one.'));
      return;
    }

    const authApp = this.authService.getApp();
    const guardApp = this.guard.getApp();
    const combined = authApp;
    combined.route('/', guardApp);

    const server = serve({
      fetch: combined.fetch,
      port: this.config.port,
      hostname: this.config.host,
    });

    server.on('error', (err: Error) => {
      console.log(chalk.yellow(`Failed to start embedded server: ${err.message}`));
    });

    console.log(chalk.gray(`UOMP server listening on ${this.config.serverUrl}`));
  }

  private isPortAvailable(port: number, host: string): Promise<boolean> {
    return new Promise(resolve => {
      const tester = net.createServer();
      tester.once('error', () => resolve(false));
      tester.once('listening', () => {
        tester.close(() => resolve(true));
      });
      tester.listen(port, host);
    });
  }
}
