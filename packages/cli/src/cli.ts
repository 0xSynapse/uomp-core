#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { UompConfig } from './config.js';
import { MemoryCommands } from './commands/memory.js';
import { RegistryCommands } from './commands/registry.js';
import { RunCommands } from './commands/run.js';
import { SessionsCommands } from './commands/sessions.js';
import { AuditCommands } from './commands/audit.js';
import { AuthorizeCommands } from './commands/authorize.js';
import { DiscoverCommands } from './commands/discover.js';
import { ConnectCommands } from './commands/connect.js';
import { ImportCommands } from './commands/import.js';
import { GatewayCommands } from './commands/gateway.js';
import { ServeCommands } from './commands/serve.js';
import { McpCommands } from './commands/mcp.js';
import { DemoCommands } from './commands/demo.js';
import { DoctorCommands } from './commands/doctor.js';
import { parseHost, parsePort } from './utils/server.js';

const program = new Command();

program
  .name('uomp')
  .description('Give agents temporary, revocable access to your local notes and memory')
  .version('0.0.1');

program
  .command('init')
  .description('Initialize UOMP data directory')
  .action(async () => {
    const config = new UompConfig();
    await config.init();
    console.log(chalk.green(`UOMP initialized at ${config.dataDir}`));
  });

program
  .command('memory', { hidden: true })
  .description('Manage memory items')
  .addCommand(MemoryCommands.add())
  .addCommand(MemoryCommands.list())
  .addCommand(MemoryCommands.get())
  .addCommand(MemoryCommands.deleteCmd())
  .addCommand(MemoryCommands.importCmd());

// New generic import command (supersedes memory import for external data)
program.addCommand(ImportCommands.get());
program.addCommand(DemoCommands.get());

program
  .command('registry', { hidden: true })
  .description('Agent registry operations')
  .addCommand(RegistryCommands.search())
  .addCommand(RegistryCommands.list())
  .addCommand(RegistryCommands.add())
  .addCommand(RegistryCommands.remove())
  .addCommand(RegistryCommands.install());

program
  .command('discover <agent>', { hidden: true })
  .description('Discover an agent from a local path or registry://<id>')
  .action(async (agent: string) => {
    const config = new UompConfig();
    await config.init();
    const discover = new DiscoverCommands(config);
    await discover.discover(agent);
  });

program
  .command('connect <agent>', { hidden: true })
  .description('Connect to an agent: verify identity, checksum, and cache manifest')
  .action(async (agent: string) => {
    const config = new UompConfig();
    await config.init();
    const connect = new ConnectCommands(config);
    await connect.connect(agent);
  });

program
  .command('authorize <agent>')
  .description('Authorize an agent and create a session')
  .option('-s, --scope <scopes...>', 'Read tags to grant (skips the interactive prompt)')
  .option('-o, --output <file>', 'Write the session env file to a custom path')
  .option('-d, --duration <minutes>', 'Session duration in minutes (1-1440)', '30')
  .option('-p, --port <port>', 'Local server port (default: 9374)')
  .option('--host <host>', 'Local server host (default: 127.0.0.1)')
  .option('--print-token', 'Print the capability token (it is also written to the env file)')
  .option('--no-server', 'Do not start the local Auth + Guard server')
  .action(async (agent: string, options: {
    scope?: string[];
    output?: string;
    duration?: string;
    port?: string;
    host?: string;
    printToken?: boolean;
    server?: boolean;
  }) => {
    try {
      const config = new UompConfig({
        port: options.port ? parsePort(options.port) : undefined,
        host: options.host ? parseHost(options.host) : undefined,
      });
      const authorizer = new AuthorizeCommands(config);
      await authorizer.authorize(agent, options);
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    }
  });

program.addCommand(ServeCommands.get());
program.addCommand(McpCommands.get());

program
  .command('sessions')
  .description('List active sessions')
  .option('-a, --all', 'Include closed sessions')
  .option('--json', 'Output JSON')
  .action(async (options: { all?: boolean; json?: boolean }) => {
    // Reuse the list command action manually
    const cmd = SessionsCommands.list();
    await cmd.parseAsync([
      'node',
      'uomp',
      ...(options.all ? ['--all'] : []),
      ...(options.json ? ['--json'] : []),
    ]);
  });

program
  .command('revoke <sessionId>')
  .description('Revoke a session and invalidate its token')
  .action(async (sessionId: string) => {
    const cmd = SessionsCommands.revoke();
    await cmd.parseAsync(['node', 'uomp', sessionId]);
  });

program
  .command('audit')
  .description('Show what agents read or attempted to read')
  .option('-s, --session <sessionId>', 'Filter by session ID')
  .option('-a, --agent <agentId>', 'Filter by agent ID')
  .option('-l, --limit <number>', 'Limit number of results', '50')
  .option('--json', 'Output JSON')
  .action(async (options: { session?: string; agent?: string; limit?: string; json?: boolean }) => {
    const cmd = AuditCommands.list();
    await cmd.parseAsync([
      'node',
      'uomp',
      ...(options.session ? ['--session', options.session] : []),
      ...(options.agent ? ['--agent', options.agent] : []),
      ...(options.limit ? ['--limit', options.limit] : []),
      ...(options.json ? ['--json'] : []),
    ]);
  });

program.addCommand(DoctorCommands.get());

program
  .command('agent', { hidden: true })
  .description('Agent developer commands')
  .addCommand(new Command('run')
    .description('Run an agent as a child process (developer shortcut)')
    .argument('<agent>', 'Agent path')
    .option('-s, --scope <scopes...>', 'Additional read scopes')
    .action(async (agent: string, options: { scope?: string[] }) => {
      const config = new UompConfig();
      await config.init();
      const runner = new RunCommands(config);
      await runner.run(agent, options.scope ?? []);
    }));

program
  .command('gateway', { hidden: true })
  .description('Gateway management')
  .addCommand(GatewayCommands.start())
  .addCommand(GatewayCommands.status());

program.addHelpText('after', `
Core flow:
  $ uomp demo
  $ uomp init
  $ uomp import ~/Obsidian/MyVault
  $ uomp authorize ./my-agent --scope notes/projects
  $ uomp sessions

Connect an MCP client (experimental):
  $ uomp mcp --session <sessionId>

Check your setup:
  $ uomp doctor

Advanced commands (hidden): memory, registry, discover, connect, agent, gateway
Run \`uomp help <command>\` for details.
`);

program.parse();
