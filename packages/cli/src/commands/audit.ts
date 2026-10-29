import { Command } from 'commander';
import chalk from 'chalk';
import { UompConfig } from '../config.js';
import { MemoryGuard } from '@uomp/guard';
import { JWTTokenIssuer } from '@uomp/token';
import { formatClock, sanitizeText } from '../utils/format.js';

export class AuditCommands {
  private static async getGuard(): Promise<MemoryGuard> {
    const config = new UompConfig();
    await config.init();
    const issuer = new JWTTokenIssuer();
    await issuer.loadOrGenerateKey(config.secretsDir);
    return new MemoryGuard({ dbPath: config.auditDbPath, memoryDbPath: config.memoryDbPath, issuer });
  }

  static list(): Command {
    return new Command('list')
      .description('List audit logs')
      .option('-s, --session <sessionId>', 'Filter by session ID')
      .option('-a, --agent <agentId>', 'Filter by agent ID')
      .option('-l, --limit <number>', 'Limit number of results', '50')
      .option('--json', 'Output JSON')
      .action(async (options: { session?: string; agent?: string; limit?: string; json?: boolean }) => {
        const limit = parseLimit(options.limit);
        if (limit === null) {
          process.exitCode = 1;
          return;
        }

        const guard = await this.getGuard();
        try {
          const logs = guard.getAuditLogs({
            sessionId: options.session,
            agentId: options.agent,
            limit,
          });

          if (options.json) {
            console.log(JSON.stringify(logs, null, 2));
            return;
          }

          if (logs.length === 0) {
            console.log(chalk.gray('No audit logs found.'));
            return;
          }

          console.log(`${chalk.bold('Audit log')} ${chalk.gray(`(${logs.length})`)}`);

          for (const log of logs) {
            const outcome = (log.allowed ? 'allow' : 'deny').padEnd(5);
            const outcomeLabel = log.allowed ? chalk.green(outcome) : chalk.red(outcome);
            const action = log.action.padEnd(6);
            const agent = sanitizeText(log.agentId);
            const target = log.key
              ? sanitizeText(log.key)
              : log.tags && log.tags.length > 0
                ? `tag:${log.tags.map(sanitizeText).join(',')}`
                : '-';

            console.log('');
            console.log(`${chalk.gray(formatClock(log.timestamp))}  ${outcomeLabel}  ${action} ${agent}  ${target}`);
            console.log(`  ${chalk.gray(sanitizeText(log.sessionId))} · ${sanitizeText(log.reason)}`);
          }
        } finally {
          guard.close();
        }
      });
  }
}

function parseLimit(value?: string): number | null {
  const limit = Number(value ?? '50');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    console.log(chalk.red(`Invalid limit "${value}". Use a number between 1 and 1000.`));
    return null;
  }
  return limit;
}
