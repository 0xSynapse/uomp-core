import Database from 'better-sqlite3';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { timingSafeEqual } from 'crypto';
import type { Scopes } from '@uomp/core';
import { generateId } from '@uomp/core';
import { JWTTokenIssuer, type CapabilityTokenPayload } from '@uomp/token';

export { loadOrCreateAdminToken } from './admin.js';

export interface Session {
  sessionId: string;
  agentId: string;
  agentName?: string;
  status: 'created' | 'active' | 'closed' | 'expired' | 'revoked';
  createdAt: string;
  expiresAt: string;
  closedAt?: string;
  grantedScopes?: Scopes;
  requestedScopes: Scopes;
  tokenHash?: string;
}

export interface AuthServiceOptions {
  dbPath: string;
  issuer: JWTTokenIssuer;
  defaultDurationMinutes?: number;
  adminToken: string;
}

export type ConsentRequestStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ConsentRequest {
  requestId: string;
  sessionId: string;
  client?: string;
  agentId: string;
  agentName?: string;
  requestedScopes: Scopes;
  envPath?: string;
  baseUrl?: string;
  status: ConsentRequestStatus;
  createdAt: string;
  expiresAt: string;
  approvedAt?: string;
  grantedScopes?: Scopes;
}

export interface CreateConsentRequestInput {
  client?: string;
  agent_id: string;
  agent_name?: string;
  requested_scopes: Scopes;
  duration_minutes?: number;
  env_path?: string;
  base_url?: string;
}

const scopeActionSchema = z.object({
  tags: z.array(z.string()).default([]),
  keys: z.array(z.string()).default([]),
  denyTags: z.array(z.string()).default([]),
  denyKeys: z.array(z.string()).default([]),
  allowedFields: z.array(z.string()).optional(),
  fields: z.record(z.array(z.string())).optional(),
  purposes: z.record(z.string()).optional(),
});

const scopesSchema = z.object({
  read: scopeActionSchema,
  write: scopeActionSchema,
});

const createSessionSchema = z.object({
  agent_id: z.string(),
  agent_name: z.string().optional(),
  requested_scopes: scopesSchema,
  duration_minutes: z.number().min(1).max(1440).default(30),
});

const grantSessionSchema = z.object({
  granted_scopes: scopesSchema,
  profile: z.string().optional(),
  audience: z.string().optional(),
  allowed_fields: z.array(z.string()).optional(),
  aggregation_only: z.boolean().optional(),
  task_bound: z.boolean().optional(),
});

const consentRequestSchema = z.object({
  client: z.string().optional(),
  agent_id: z.string(),
  agent_name: z.string().optional(),
  requested_scopes: scopesSchema,
  duration_minutes: z.number().min(1).max(1440).default(30),
  env_path: z.string().optional(),
  base_url: z.string().optional(),
});

const deletionProofSchema = z.object({
  deletion_proof_id: z.string(),
  session_id: z.string(),
  agent_id: z.string(),
  deleted_at: z.string(),
  memory_hash: z.string(),
  fields_accessed: z.array(z.string()).optional(),
  method: z.string(),
  proof_value: z.string(),
});

export function validateGrantedScopes(requested: Scopes, granted: Scopes): string | null {
  const errors: string[] = [];

  for (const action of ['read', 'write'] as const) {
    const requestedAction = requested[action];
    const grantedAction = granted[action];
    if (!requestedAction) {
      errors.push(`${action}: requested scope is missing`);
      continue;
    }
    if (!grantedAction) {
      errors.push(`${action}: granted scope is missing`);
      continue;
    }

    for (const field of ['tags', 'keys'] as const) {
      const extra = (grantedAction[field] ?? []).filter(value => !(requestedAction[field] ?? []).includes(value));
      if (extra.length > 0) {
        errors.push(`${action}.${field} exceeds requested scope: ${extra.join(', ')}`);
      }
    }

    for (const field of ['denyTags', 'denyKeys'] as const) {
      const removed = (requestedAction[field] ?? []).filter(value => !(grantedAction[field] ?? []).includes(value));
      if (removed.length > 0) {
        errors.push(`${action}.${field} removes requested denial: ${removed.join(', ')}`);
      }
    }
  }

  return errors.length > 0 ? errors.join('; ') : null;
}

export function validateGrantedFields(requested: Scopes, granted?: string[]): string | null {
  const requestedFields = requested.read.allowedFields ?? [];
  if (requestedFields.length === 0) {
    return null;
  }

  if (!granted || granted.length === 0) {
    return 'read.allowedFields must be granted when requested';
  }

  const extra = granted.filter(field => !requestedFields.includes(field));
  if (extra.length > 0) {
    return `read.allowedFields exceeds requested scope: ${extra.join(', ')}`;
  }

  return null;
}

export function validateConsentGrant(requested: Scopes, granted: Scopes): string | null {
  const errors: string[] = [];

  for (const action of ['read', 'write'] as const) {
    const requestedAction = requested[action];
    const grantedAction = granted[action];
    if (!requestedAction || !grantedAction) {
      errors.push(`${action}: scope is missing`);
      continue;
    }

    const extraTags = grantedAction.tags.filter(tag => !requestedAction.tags.includes(tag));
    if (extraTags.length > 0) {
      errors.push(`${action}.tags exceeds requested scope: ${extraTags.join(', ')}`);
    }

    for (const field of ['denyTags', 'denyKeys'] as const) {
      const removed = requestedAction[field].filter(value => !grantedAction[field].includes(value));
      if (removed.length > 0) {
        errors.push(`${action}.${field} removes requested denial: ${removed.join(', ')}`);
      }
    }

    if (action === 'write') {
      const extraKeys = grantedAction.keys.filter(key => !requestedAction.keys.includes(key));
      if (extraKeys.length > 0) {
        errors.push(`${action}.keys exceeds requested scope: ${extraKeys.join(', ')}`);
      }
    }
  }

  return errors.length > 0 ? errors.join('; ') : null;
}

export class AuthService {
  private db: Database.Database;
  private issuer: JWTTokenIssuer;
  private defaultDurationMinutes: number;
  private adminToken: string;
  private app: Hono;

  constructor(options: AuthServiceOptions) {
    this.db = new Database(options.dbPath);
    this.issuer = options.issuer;
    this.defaultDurationMinutes = options.defaultDurationMinutes ?? 30;
    this.adminToken = options.adminToken;
    this.initSchema();
    this.app = this.createApp();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        agent_name TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        closed_at TEXT,
        requested_scopes TEXT NOT NULL,
        granted_scopes TEXT,
        token_hash TEXT
      );

      CREATE TABLE IF NOT EXISTS token_blacklist (
        token_hash TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS consent_requests (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        client TEXT,
        agent_id TEXT NOT NULL,
        agent_name TEXT,
        requested_scopes TEXT NOT NULL,
        env_path TEXT,
        base_url TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        approved_at TEXT,
        granted_scopes TEXT
      );
    `);
  }

  getApp(): Hono {
    return this.app;
  }

  private requireAdmin(c: Context): Response | null {
    const provided = c.req.header('x-uomp-admin-token');
    if (!this.adminToken || !provided) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Admin token required' } }, 401);
    }

    const expected = Buffer.from(this.adminToken);
    const actual = Buffer.from(provided);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid admin token' } }, 401);
    }

    return null;
  }

  private createApp(): Hono {
    const app = new Hono();

    app.get('/health', c => c.json({ status: 'ok', service: 'uomp' }));

    app.post('/v1/sessions', async c => {
      const unauthorized = this.requireAdmin(c);
      if (unauthorized) return unauthorized;

      const body = await c.req.json();
      const parsed = createSessionSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { code: 'INVALID_REQUEST', message: parsed.error.message } }, 400);
      }

      const session = this.createSession(parsed.data);
      return c.json({
        session_id: session.sessionId,
        status: session.status,
        agent_id: session.agentId,
        requested_scopes: session.requestedScopes,
        expires_at: session.expiresAt,
      });
    });

    app.post('/v1/sessions/:id/grant', async c => {
      const unauthorized = this.requireAdmin(c);
      if (unauthorized) return unauthorized;

      const sessionId = c.req.param('id');
      const body = await c.req.json();
      const parsed = grantSessionSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { code: 'INVALID_REQUEST', message: parsed.error.message } }, 400);
      }

      const session = this.getSession(sessionId);
      if (!session) {
        return c.json({ error: { code: 'SESSION_NOT_FOUND', message: 'Session not found or not in created state' } }, 404);
      }

      const scopeError = validateGrantedScopes(session.requestedScopes, parsed.data.granted_scopes);
      if (scopeError) {
        return c.json({ error: { code: 'SCOPE_EXCEEDS_REQUEST', message: scopeError } }, 400);
      }

      const fieldError = validateGrantedFields(session.requestedScopes, parsed.data.allowed_fields);
      if (fieldError) {
        return c.json({ error: { code: 'SCOPE_EXCEEDS_REQUEST', message: fieldError } }, 400);
      }

      const result = await this.grantSession(sessionId, parsed.data.granted_scopes, {
        profile: parsed.data.profile,
        audience: parsed.data.audience,
        allowedFields: parsed.data.allowed_fields,
        aggregationOnly: parsed.data.aggregation_only,
        taskBound: parsed.data.task_bound,
      });
      if (!result) {
        return c.json({ error: { code: 'SESSION_NOT_FOUND', message: 'Session not found or not in created state' } }, 404);
      }

      return c.json({
        token: result.token,
        token_type: 'Bearer',
        expires_at: result.expiresAt,
      });
    });

    app.post('/v1/sessions/:id/close', c => {
      const sessionId = c.req.param('id');
      const session = this.closeSession(sessionId);
      if (!session) {
        return c.json({ error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } }, 404);
      }
      return c.json({ session_id: session.sessionId, status: session.status });
    });

    app.post('/v1/sessions/:id/revoke', c => {
      const unauthorized = this.requireAdmin(c);
      if (unauthorized) return unauthorized;

      const sessionId = c.req.param('id');
      const session = this.revokeSession(sessionId);
      if (!session) {
        return c.json({ error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } }, 404);
      }
      return c.json({ session_id: session.sessionId, status: session.status });
    });

    app.post('/v1/tokens/validate', async c => {
      const body = await c.req.json();
      const token = body.token as string;
      try {
        const payload = await this.issuer.verify(token);
        const session = this.getSession(payload.sessionId);
        const isBlacklisted = this.isTokenBlacklisted(payload.sessionId);
        const isActive = session?.status === 'active';
        return c.json({
          valid: isActive && !isBlacklisted,
          session_id: payload.sessionId,
          expires_at: payload.expiresAt,
        });
      } catch {
        return c.json({ valid: false }, 400);
      }
    });

    app.post('/v1/sessions/:id/deletion-proof', async c => {
      const sessionId = c.req.param('id');
      const body = await c.req.json();
      const parsed = deletionProofSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { code: 'INVALID_REQUEST', message: parsed.error.message } }, 400);
      }

      const proof = parsed.data;
      if (proof.session_id !== sessionId) {
        return c.json({ error: { code: 'INVALID_REQUEST', message: 'session_id mismatch' } }, 400);
      }

      const row = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as Record<string, string> | undefined;
      if (!row) {
        return c.json({ error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } }, 404);
      }

      // Close the session if task_bound (or always close on deletion proof)
      this.db.prepare(`
        UPDATE sessions SET status = 'closed', closed_at = ?
        WHERE session_id = ? AND status = 'active'
      `).run(new Date().toISOString(), sessionId);

      return c.json({ status: 'accepted', deletion_proof_id: proof.deletion_proof_id });
    });

    app.post('/v1/consent/requests', async c => {
      const unauthorized = this.requireAdmin(c);
      if (unauthorized) return unauthorized;

      const body = await c.req.json();
      const parsed = consentRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { code: 'INVALID_REQUEST', message: parsed.error.message } }, 400);
      }

      const request = this.createConsentRequest(parsed.data);
      return c.json({
        request_id: request.requestId,
        session_id: request.sessionId,
        status: request.status,
        client: request.client,
        agent_id: request.agentId,
        requested_scopes: request.requestedScopes,
        expires_at: request.expiresAt,
      });
    });

    app.get('/v1/consent/requests', c => {
      const unauthorized = this.requireAdmin(c);
      if (unauthorized) return unauthorized;

      const status = c.req.query('status') as ConsentRequestStatus | undefined;
      return c.json(this.listConsentRequests(status));
    });

    app.get('/v1/consent/requests/:id', c => {
      const unauthorized = this.requireAdmin(c);
      if (unauthorized) return unauthorized;

      const request = this.getConsentRequest(c.req.param('id'));
      if (!request) {
        return c.json({ error: { code: 'REQUEST_NOT_FOUND', message: 'Consent request not found' } }, 404);
      }
      return c.json(request);
    });

    app.post('/v1/consent/requests/:id/approve', async c => {
      const unauthorized = this.requireAdmin(c);
      if (unauthorized) return unauthorized;

      const body = await c.req.json();
      const parsed = grantSessionSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { code: 'INVALID_REQUEST', message: parsed.error.message } }, 400);
      }

      try {
        const result = await this.approveConsentRequest(c.req.param('id'), parsed.data.granted_scopes);
        if (!result) {
          return c.json({ error: { code: 'REQUEST_NOT_FOUND', message: 'Consent request not found or not pending' } }, 404);
        }
        return c.json({
          token: result.token,
          token_type: 'Bearer',
          session_id: result.sessionId,
          expires_at: result.expiresAt,
        });
      } catch (error) {
        return c.json({
          error: {
            code: 'SCOPE_EXCEEDS_REQUEST',
            message: error instanceof Error ? error.message : String(error),
          },
        }, 400);
      }
    });

    app.post('/v1/consent/requests/:id/deny', c => {
      const unauthorized = this.requireAdmin(c);
      if (unauthorized) return unauthorized;

      const request = this.denyConsentRequest(c.req.param('id'));
      if (!request) {
        return c.json({ error: { code: 'REQUEST_NOT_FOUND', message: 'Consent request not found or not pending' } }, 404);
      }
      return c.json({ request_id: request.requestId, status: request.status });
    });

    return app;
  }

  createSession(data: z.infer<typeof createSessionSchema>): Session {
    const sessionId = generateId('sess');
    const now = new Date();
    const duration = data.duration_minutes ?? this.defaultDurationMinutes;
    const expiresAt = new Date(now.getTime() + duration * 60 * 1000);

    const session: Session = {
      sessionId,
      agentId: data.agent_id,
      agentName: data.agent_name,
      status: 'created',
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      requestedScopes: data.requested_scopes,
    };

    const stmt = this.db.prepare(`
      INSERT INTO sessions (session_id, agent_id, agent_name, status, created_at, expires_at, requested_scopes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      session.sessionId,
      session.agentId,
      session.agentName ?? null,
      session.status,
      session.createdAt,
      session.expiresAt,
      JSON.stringify(session.requestedScopes)
    );

    return session;
  }

  createConsentRequest(data: CreateConsentRequestInput): ConsentRequest {
    const session = this.createSession({
      agent_id: data.agent_id,
      ...(data.agent_name ? { agent_name: data.agent_name } : {}),
      requested_scopes: data.requested_scopes,
      duration_minutes: data.duration_minutes ?? this.defaultDurationMinutes,
    });

    const requestId = generateId('consent');
    const createdAt = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO consent_requests (
        request_id, session_id, client, agent_id, agent_name, requested_scopes,
        env_path, base_url, status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      requestId,
      session.sessionId,
      data.client ?? null,
      data.agent_id,
      data.agent_name ?? null,
      JSON.stringify(data.requested_scopes),
      data.env_path ?? null,
      data.base_url ?? null,
      createdAt,
      session.expiresAt
    );

    return {
      requestId,
      sessionId: session.sessionId,
      ...(data.client ? { client: data.client } : {}),
      agentId: data.agent_id,
      ...(data.agent_name ? { agentName: data.agent_name } : {}),
      requestedScopes: data.requested_scopes,
      ...(data.env_path ? { envPath: data.env_path } : {}),
      ...(data.base_url ? { baseUrl: data.base_url } : {}),
      status: 'pending',
      createdAt,
      expiresAt: session.expiresAt,
    };
  }

  getConsentRequest(requestId: string): ConsentRequest | null {
    const row = this.db.prepare('SELECT * FROM consent_requests WHERE request_id = ?')
      .get(requestId) as Record<string, string> | undefined;
    if (!row) return null;

    if (row.status === 'pending' && Date.parse(row.expires_at) <= Date.now()) {
      this.db.prepare("UPDATE consent_requests SET status = 'expired' WHERE request_id = ? AND status = 'pending'")
        .run(requestId);
      this.closeSession(row.session_id);
      return this.deserializeConsentRequest({ ...row, status: 'expired' });
    }

    return this.deserializeConsentRequest(row);
  }

  listConsentRequests(status: ConsentRequestStatus = 'pending'): ConsentRequest[] {
    const rows = this.db.prepare('SELECT * FROM consent_requests WHERE status = ? ORDER BY created_at DESC')
      .all(status) as Record<string, string>[];
    const requests = rows.map(row => this.deserializeConsentRequest(row));

    if (status === 'pending') {
      for (const request of requests) {
        if (Date.parse(request.expiresAt) <= Date.now()) {
          this.db.prepare("UPDATE consent_requests SET status = 'expired' WHERE request_id = ? AND status = 'pending'")
            .run(request.requestId);
          this.closeSession(request.sessionId);
          request.status = 'expired';
        }
      }
      return requests.filter(request => request.status === 'pending');
    }

    return requests;
  }

  async approveConsentRequest(
    requestId: string,
    grantedScopes: Scopes
  ): Promise<{ token: string; expiresAt: string; sessionId: string } | null> {
    const request = this.getConsentRequest(requestId);
    if (!request || request.status !== 'pending') {
      return null;
    }

    const scopeError = validateConsentGrant(request.requestedScopes, grantedScopes);
    if (scopeError) {
      throw new Error(scopeError);
    }

    const result = await this.grantSession(request.sessionId, grantedScopes);
    if (!result) {
      return null;
    }

    this.db.prepare(`
      UPDATE consent_requests
      SET status = 'approved', approved_at = ?, granted_scopes = ?
      WHERE request_id = ? AND status = 'pending'
    `).run(new Date().toISOString(), JSON.stringify(grantedScopes), requestId);

    return {
      token: result.token,
      expiresAt: result.expiresAt,
      sessionId: request.sessionId,
    };
  }

  denyConsentRequest(requestId: string): ConsentRequest | null {
    const request = this.getConsentRequest(requestId);
    if (!request || request.status !== 'pending') {
      return null;
    }

    this.db.prepare("UPDATE consent_requests SET status = 'denied', approved_at = ? WHERE request_id = ? AND status = 'pending'")
      .run(new Date().toISOString(), requestId);
    this.closeSession(request.sessionId);

    return { ...request, status: 'denied' };
  }

  async grantSession(
    sessionId: string,
    grantedScopes: Scopes,
    options?: { profile?: string; audience?: string; allowedFields?: string[]; aggregationOnly?: boolean; taskBound?: boolean }
  ): Promise<{ token: string; expiresAt: string } | null> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as Record<string, string> | undefined;
    if (!row || row.status !== 'created') {
      return null;
    }

    const expiresAt = new Date(row.expires_at);
    const profile = options?.profile ?? 'local';
    const audience = options?.audience ?? (profile === 'remote' ? undefined : `http://127.0.0.1:9374`);
    const payload: CapabilityTokenPayload = {
      version: '1.0',
      sessionId,
      agentId: row.agent_id,
      issuedAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      scopes: grantedScopes,
      profile,
      audience,
      limits: { maxReadQueries: 100, maxWriteQueries: 0 },
      allowedFields: options?.allowedFields ?? grantedScopes.read?.allowedFields,
      aggregationOnly: options?.aggregationOnly ?? false,
      taskBound: options?.taskBound ?? false,
    };

    const token = await this.issuer.issue(payload);
    const tokenHash = this.hashToken(token);

    const updated = this.db.prepare(`
      UPDATE sessions SET status = 'active', granted_scopes = ?, token_hash = ?
      WHERE session_id = ? AND status = 'created'
    `).run(JSON.stringify(grantedScopes), tokenHash, sessionId);
    if (updated.changes !== 1) {
      return null;
    }

    return { token, expiresAt: expiresAt.toISOString() };
  }

  closeSession(sessionId: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as Record<string, string> | undefined;
    if (!row) return null;

    if (row.status === 'revoked') {
      return this.deserializeSession(row);
    }

    const now = new Date().toISOString();
    const updated = this.db.prepare(`
      UPDATE sessions SET status = 'closed', closed_at = ?
      WHERE session_id = ? AND status IN ('created', 'active')
    `).run(now, sessionId);

    if (updated.changes === 0) {
      const current = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as Record<string, string> | undefined;
      return current ? this.deserializeSession(current) : null;
    }

    if (row.token_hash) {
      this.blacklistToken(row.token_hash, sessionId, row.expires_at);
    }

    return this.deserializeSession(row, 'closed');
  }

  revokeSession(sessionId: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as Record<string, string> | undefined;
    if (!row) return null;

    if (row.status === 'revoked') {
      return this.deserializeSession(row);
    }

    const now = new Date().toISOString();
    const updated = this.db.prepare(`
      UPDATE sessions SET status = 'revoked', closed_at = ?
      WHERE session_id = ? AND status != 'revoked'
    `).run(now, sessionId);

    if (updated.changes === 0) {
      const current = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as Record<string, string> | undefined;
      return current ? this.deserializeSession(current) : null;
    }

    if (row.token_hash) {
      this.blacklistToken(row.token_hash, sessionId, row.expires_at);
    }

    return this.deserializeSession(row, 'revoked');
  }

  getSession(sessionId: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as Record<string, string> | undefined;
    return row ? this.deserializeSession(row) : null;
  }

  listSessions(options: { includeClosed?: boolean } = {}): Session[] {
    const where = options.includeClosed ? '' : "WHERE status = 'active'";
    const rows = this.db.prepare(`SELECT * FROM sessions ${where} ORDER BY created_at DESC`).all() as Record<string, string>[];
    return rows.map(row => this.deserializeSession(row));
  }

  isTokenBlacklisted(sessionId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM token_blacklist WHERE session_id = ?').get(sessionId);
    return !!row;
  }

  private blacklistToken(tokenHash: string, sessionId: string, expiresAt: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO token_blacklist (token_hash, session_id, expires_at)
      VALUES (?, ?, ?)
    `).run(tokenHash, sessionId, expiresAt);
  }

  private hashToken(token: string): string {
    // Simple hash for MVP. In production use crypto.subtle.digest.
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      const char = token.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  }

  private deserializeSession(row: Record<string, string>, overrideStatus?: string): Session {
    return {
      sessionId: row.session_id,
      agentId: row.agent_id,
      agentName: row.agent_name,
      status: (overrideStatus ?? row.status) as Session['status'],
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      closedAt: row.closed_at,
      requestedScopes: JSON.parse(row.requested_scopes) as Scopes,
      grantedScopes: row.granted_scopes ? (JSON.parse(row.granted_scopes) as Scopes) : undefined,
      tokenHash: row.token_hash,
    };
  }

  private deserializeConsentRequest(row: Record<string, string>): ConsentRequest {
    return {
      requestId: row.request_id,
      sessionId: row.session_id,
      ...(row.client ? { client: row.client } : {}),
      agentId: row.agent_id,
      ...(row.agent_name ? { agentName: row.agent_name } : {}),
      requestedScopes: JSON.parse(row.requested_scopes) as Scopes,
      ...(row.env_path ? { envPath: row.env_path } : {}),
      ...(row.base_url ? { baseUrl: row.base_url } : {}),
      status: row.status as ConsentRequestStatus,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      ...(row.approved_at ? { approvedAt: row.approved_at } : {}),
      ...(row.granted_scopes ? { grantedScopes: JSON.parse(row.granted_scopes) as Scopes } : {}),
    };
  }

  close(): void {
    this.db.close();
  }
}
