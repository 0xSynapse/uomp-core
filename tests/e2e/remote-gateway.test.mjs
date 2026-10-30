import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import net from 'node:net';

import { MemoryStore } from '../../packages/store/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const AEGIS_BIN = process.env.AEGIS_OS_BIN ?? resolve(ROOT, '../aegis-os/target/debug/aegis-os');
const OPENSSL = process.env.OPENSSL_BIN ?? 'openssl';
const AUDIENCE = 'https://memory.test.local';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf-8', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitFor(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('timed out waiting for condition');
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${url} -> ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function httpsRequest({ port, path, token, ca, cert, key }) {
  return new Promise((resolveRequest, reject) => {
    const request = https.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'GET',
      ca,
      cert,
      key,
      servername: 'localhost',
      headers: { authorization: `Bearer ${token}` },
    }, (response) => {
      let body = '';
      response.setEncoding('utf-8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolveRequest({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

function makeCerts(dir) {
  const caKey = join(dir, 'ca-key.pem');
  const caCert = join(dir, 'ca.pem');
  const serverKey = join(dir, 'server-key.pem');
  const serverCsr = join(dir, 'server.csr');
  const serverCert = join(dir, 'server.pem');
  const clientKey = join(dir, 'client-key.pem');
  const clientCsr = join(dir, 'client.csr');
  const clientCert = join(dir, 'client.pem');
  const san = join(dir, 'san.cnf');
  writeFileSync(san, 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');

  run(OPENSSL, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', caCert, '-days', '1', '-subj', '/CN=UOMP Test CA']);
  run(OPENSSL, ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', serverKey, '-out', serverCsr, '-subj', '/CN=localhost']);
  run(OPENSSL, ['x509', '-req', '-in', serverCsr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-out', serverCert, '-days', '1', '-extfile', san]);
  run(OPENSSL, ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', clientKey, '-out', clientCsr, '-subj', '/CN=remote-agent']);
  run(OPENSSL, ['x509', '-req', '-in', clientCsr, '-CA', caCert, '-CAkey', caKey, '-CAserial', join(dir, 'ca.srl'), '-out', clientCert, '-days', '1']);

  return { ca: readFileSync(caCert), serverCert, serverKey, clientCert: readFileSync(clientCert), clientKey: readFileSync(clientKey) };
}

test('remote Agent reaches local Guard through the mTLS Aegis Memory Gateway', { timeout: 90_000 }, async (t) => {
  if (spawnSync(AEGIS_BIN, ['--version'], { encoding: 'utf-8' }).status !== 0) {
    t.skip(`Aegis binary not found at ${AEGIS_BIN}; build with cargo build -p aos-cli`);
    return;
  }
  if (spawnSync(OPENSSL, ['version'], { encoding: 'utf-8' }).status !== 0) {
    t.skip('openssl is required for the mTLS test');
    return;
  }

  const home = mkdtempSync(join(tmpdir(), 'uomp-remote-gateway-'));
  const dataDir = join(home, '.uomp');
  mkdirSync(join(dataDir, '.secrets'), { recursive: true });
  const memoryDbPath = join(dataDir, 'memory.db');
  const store = new MemoryStore({ dbPath: memoryDbPath });
  await store.set({
    key: 'note.projects.plan',
    value: { title: 'Plan', body: 'Ship it.' },
    tags: ['notes', 'notes/projects'],
    sensitivity: 'low',
    source: 'user',
  });
  store.close();

  const uompPort = await freePort();
  const gatewayPort = await freePort();
  const certs = makeCerts(home);
  const auditPath = join(home, 'gateway-audit.jsonl');

  const uomp = spawn(process.execPath, [join(ROOT, 'apps/server/dist/index.js')], {
    env: { ...process.env, HOME: home, UOMP_HOST: '127.0.0.1', UOMP_PORT: String(uompPort), NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let uompLog = '';
  uomp.stdout.on('data', (chunk) => { uompLog += chunk; });
  uomp.stderr.on('data', (chunk) => { uompLog += chunk; });

  let gateway;
  t.after(() => {
    gateway?.kill('SIGTERM');
    uomp.kill('SIGTERM');
    rmSync(home, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${uompPort}`;
  await waitFor(async () => {
    try {
      return (await fetch(`${base}/health`)).ok;
    } catch {
      return false;
    }
  }, 20_000).catch((error) => {
    throw new Error(`${error.message}\nUOMP log:\n${uompLog}`);
  });

  const adminToken = readFileSync(join(dataDir, '.secrets', 'admin-token'), 'utf-8').trim();
  const publicJwk = join(dataDir, '.secrets', 'ed25519-public.jwk');
  const adminHeaders = { 'content-type': 'application/json', 'x-uomp-admin-token': adminToken };
  const readScope = { tags: ['notes/projects'], keys: [], denyTags: [], denyKeys: [] };
  const writeScope = { tags: [], keys: [], denyTags: [], denyKeys: [] };
  const scopes = { read: readScope, write: writeScope };

  const session = await jsonRequest(`${base}/v1/sessions`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      agent_id: 'remote-agent',
      agent_name: 'Remote Agent',
      requested_scopes: scopes,
      duration_minutes: 5,
    }),
  });

  const grant = await jsonRequest(`${base}/v1/sessions/${session.session_id}/grant`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ granted_scopes: scopes, profile: 'remote', audience: AUDIENCE }),
  });
  assert.ok(grant.token, 'remote grant must return a token');

  gateway = spawn(AEGIS_BIN, [
    'memory-gateway',
    '--listen', `127.0.0.1:${gatewayPort}`,
    '--guard-url', base,
    '--public-key', publicJwk,
    '--audience', AUDIENCE,
    '--allowed-endpoint', '/v1/memory',
    '--tls-cert', certs.serverCert,
    '--tls-key', certs.serverKey,
    '--client-ca', join(home, 'ca.pem'),
    '--audit-log', auditPath,
  ], {
    env: { ...process.env, HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let gatewayLog = '';
  gateway.stdout.on('data', (chunk) => { gatewayLog += chunk; });
  gateway.stderr.on('data', (chunk) => { gatewayLog += chunk; });

  await waitFor(async () => {
    try {
      const socket = net.createConnection({ host: '127.0.0.1', port: gatewayPort });
      await new Promise((resolveConnect, reject) => {
        socket.once('connect', resolveConnect);
        socket.once('error', reject);
      });
      socket.destroy();
      return true;
    } catch {
      return false;
    }
  }, 20_000).catch((error) => {
    throw new Error(`${error.message}\nGateway log:\n${gatewayLog}\nUOMP log:\n${uompLog}`);
  });

  const allowed = await httpsRequest({
    port: gatewayPort,
    path: '/v1/memory?tag=notes/projects',
    token: grant.token,
    ca: certs.ca,
    cert: certs.clientCert,
    key: certs.clientKey,
  });
  assert.equal(allowed.status, 200, allowed.body);
  assert.match(allowed.body, /note\.projects\.plan/);
  assert.match(allowed.body, /Ship it/);

  const denied = await httpsRequest({
    port: gatewayPort,
    path: '/v1/memory?tag=notes/journal',
    token: grant.token,
    ca: certs.ca,
    cert: certs.clientCert,
    key: certs.clientKey,
  });
  assert.equal(denied.status, 403, denied.body);

  await jsonRequest(`${base}/v1/sessions/${session.session_id}/revoke`, {
    method: 'POST',
    headers: adminHeaders,
  });

  const revoked = await httpsRequest({
    port: gatewayPort,
    path: '/v1/memory?tag=notes/projects',
    token: grant.token,
    ca: certs.ca,
    cert: certs.clientCert,
    key: certs.clientKey,
  });
  assert.equal(revoked.status, 401, revoked.body);

  const audit = readFileSync(auditPath, 'utf-8');
  assert.match(audit, /"decision":"allow"/);
  assert.match(audit, /"decision":"deny"/);

  // A token minted for a different Gateway audience must be rejected.
  const wrongSession = await jsonRequest(`${base}/v1/sessions`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      agent_id: 'remote-agent',
      agent_name: 'Remote Agent',
      requested_scopes: scopes,
      duration_minutes: 5,
    }),
  });
  const wrongGrant = await jsonRequest(`${base}/v1/sessions/${wrongSession.session_id}/grant`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      granted_scopes: scopes,
      profile: 'remote',
      audience: 'https://wrong.example.com',
    }),
  });
  const wrongAudience = await httpsRequest({
    port: gatewayPort,
    path: '/v1/memory?tag=notes/projects',
    token: wrongGrant.token,
    ca: certs.ca,
    cert: certs.clientCert,
    key: certs.clientKey,
  });
  assert.equal(wrongAudience.status, 403, wrongAudience.body);
});
