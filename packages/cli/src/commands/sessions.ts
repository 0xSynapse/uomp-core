import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import { join } from 'path';
import { UompConfig } from '../config.js';
import { AuthService } from '@uomp/auth';
import { MemoryGuard } from '@uomp/guard';
import { JWTTokenIssuer } from '@uomp/token';

export class SessionsCommands {
  private static async getServices(): Promise<{ config: UompConfig; auth: AuthService; guard: MemoryGuard }> {
    const config = new UompConfig();
    await config.init();
    const issuer = new JWTTokenIssuer();
    await issuer.loadOrGenerateKey(config.secretsDir);
    const auth = new AuthService({ dbPath: config.authDbPath, issuer, adminToken: config.adminToken });
    const guard = new MemoryGuard({ dbPath: config.auditDbPath, memoryDbPath: config.memoryDbPath, issuer });
    return { config, auth, guard };
  }

  static list(): Command {
    return new Command('list')
      .description('List active sessions')
      .option('-a, --all', 'Include closed sessions')
      .action(async (options: { all?: boolean }) => {
        const { auth, guard } = await this.getServices();
        try {
          const db = (auth as unknown as { db: { prepare: (sql: string) => { all: () => Record<string, string>[] } } }).db;
          const statusFilter = options.all ? '' : "WHERE status = 'active'";
          const rows = db.prepare(`SELECT * FROM sessions ${statusFilter} ORDER BY created_at DESC`).all();

          if (rows.length === 0) {
            console.log(chalk.gray('No sessions found.'));
            return;
          }

          console.log(chalk.bold(options.all ? 'All sessions:' : 'Active sessions:'));
          for (const row of rows) {
            const lastAccess = guard.getLastAccessForSession(row.session_id);
            const isActive = row.status === 'active';
            const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
            const now = new Date();
            const remaining = expiresAt ? Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 60000)) : 0;
            const statusLabel = isActive ? chalk.green('active') : chalk.gray(row.status);

            console.log(`${chalk.cyan(row.session_id)} | ${row.agent_id} | status: ${statusLabel} | remaining: ${isActive ? `${remaining} min` : '-'}`);
            if (lastAccess) {
              console.log(`  last access: ${lastAccess.timestamp}  ${lastAccess.action} ${lastAccess.endpoint ?? ''}`);
            }
          }
        } finally {
          auth.close();
          guard.close();
        }
      });
  }

  static revoke(): Command {
    return new Command('revoke')
      .description('Revoke a session')
      .argument('<sessionId>', 'Session ID')
      .action(async (sessionId: string) => {
        const { config, auth, guard } = await this.getServices();
        try {
          const session = auth.revokeSession(sessionId);
          if (session) {
            console.log(chalk.green(`Revoked session: ${sessionId}`));

            const envPath = join(config.sessionsDir, `${sessionId}.env`);
            if (existsSync(envPath)) {
              await rm(envPath, { force: true });
              console.log(chalk.gray(`Removed env file: ${envPath}`));
            }
          } else {
            console.log(chalk.red('Session not found'));
            process.exitCode = 1;
          }
        } finally {
          auth.close();
          guard.close();
        }
      });
  }
}
