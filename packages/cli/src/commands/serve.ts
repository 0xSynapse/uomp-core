import { Command } from 'commander';
import chalk from 'chalk';
import { DEFAULT_HOST, DEFAULT_PORT } from '@uomp/core';
import { UompConfig } from '../config.js';
import {
  createUompRuntime,
  installShutdownHandlers,
  isLoopbackHost,
  parseHost,
  parsePort,
  startUompServer,
} from '../utils/server.js';

export class ServeCommands {
  static get(): Command {
    return new Command('serve')
      .description('Start the local UOMP server (Auth + Memory Guard)')
      .option('-p, --port <port>', 'Port to listen on', String(DEFAULT_PORT))
      .option('--host <host>', 'Host to bind to', DEFAULT_HOST)
      .action(async (options: { port: string; host: string }) => {
        try {
          const port = parsePort(options.port);
          const host = parseHost(options.host);
          const config = new UompConfig({ port, host });
          const runtime = await createUompRuntime(config);

          if (!isLoopbackHost(host)) {
            console.log(chalk.yellow(`Warning: ${host} exposes the UOMP server beyond localhost.`));
          }

          const server = await startUompServer(runtime);
          if (server.status === 'in-use') {
            runtime.close();
            if (server.isUomp) {
              console.log(chalk.gray(`A UOMP server is already running on ${server.url}.`));
              return;
            }

            console.error(chalk.red(`Port ${port} is in use by another process.`));
            console.error(chalk.gray('Stop the other process or choose another port with --port.'));
            process.exitCode = 1;
            return;
          }

          console.log(chalk.green(`UOMP server listening on ${server.url}`));
          console.log(chalk.gray('Keep this terminal open. Press Ctrl+C to stop.'));
          installShutdownHandlers(() => server.close());
        } catch (error) {
          console.error(chalk.red(error instanceof Error ? error.message : String(error)));
          process.exitCode = 1;
        }
      });
  }
}
