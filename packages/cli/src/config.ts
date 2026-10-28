import { mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import {
  DATA_DIR_NAME,
  AGENTS_DIR_NAME,
  SECRETS_DIR_NAME,
  MEMORY_DB_NAME,
  AUDIT_DB_NAME,
  AUTH_DB_NAME,
  DEFAULT_PORT,
  DEFAULT_HOST,
} from '@uomp/core';
import { loadOrCreateAdminToken } from '@uomp/auth';

export class UompConfig {
  readonly dataDir: string;
  readonly agentsDir: string;
  readonly registryDir: string;
  readonly secretsDir: string;
  readonly memoryDbPath: string;
  readonly auditDbPath: string;
  readonly authDbPath: string;
  readonly port: number;
  readonly host: string;
  adminToken!: string;

  constructor() {
    this.dataDir = join(homedir(), DATA_DIR_NAME);
    this.agentsDir = join(this.dataDir, AGENTS_DIR_NAME);
    this.registryDir = join(this.dataDir, 'registry');
    this.secretsDir = join(this.dataDir, SECRETS_DIR_NAME);
    this.memoryDbPath = join(this.dataDir, MEMORY_DB_NAME);
    this.auditDbPath = join(this.dataDir, AUDIT_DB_NAME);
    this.authDbPath = join(this.dataDir, AUTH_DB_NAME);
    this.port = DEFAULT_PORT;
    this.host = DEFAULT_HOST;
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await mkdir(this.agentsDir, { recursive: true });
    await mkdir(this.registryDir, { recursive: true });
    await mkdir(this.secretsDir, { recursive: true });
    this.adminToken = loadOrCreateAdminToken(this.secretsDir);
  }

  get serverUrl(): string {
    return `http://${this.host}:${this.port}`;
  }
}
