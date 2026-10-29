import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

const CLI = new URL('../../packages/cli/dist/cli.js', import.meta.url).pathname;

function runCli(home, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, HOME: home, NO_COLOR: '1' },
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function startMcp(home, envPath, port) {
  const child = spawn(process.execPath, [
    CLI,
    'mcp',
    '--session', envPath,
    '--on-demand',
    '--client', 'claude',
    '--request-scope', 'notes/projects',
    '--base-url', `http://127.0.0.1:${port}`,
  ], {
    env: { ...process.env, HOME: home, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });

  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.id != null && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });

  let nextId = 1;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timed out waiting for ${method}: ${stderr}`));
    }, 15_000);
    pending.set(id, message => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  const exited = new Promise(resolve => child.once('exit', resolve));

  return {
    request,
    stderr: () => stderr,
    async close() {
      child.stdin.end();
      return exited;
    },
    kill() {
      child.kill('SIGTERM');
    },
  };
}

test('on-demand consent creates a request and works after approval', async t => {
  const home = mkdtempSync(join(tmpdir(), 'uomp-on-demand-'));
  const vault = join(home, 'vault');
  const configPath = join(home, 'claude.json');
  const envPath = join(home, '.uomp', 'sessions', 'claude.env');
  const port = await getFreePort();

  mkdirSync(join(vault, 'projects'), { recursive: true });
  writeFileSync(join(vault, 'projects', 'plan.md'), [
    '---',
    'title: Plan',
    '---',
    '# Plan',
    'Ship it.',
    '',
  ].join('\n'));

  t.after(async () => {
    runCli(home, ['stop']);
    rmSync(home, { recursive: true, force: true });
  });

  const connected = runCli(home, [
    'connect', 'claude',
    '--vault', vault,
    '--scope', 'notes/projects',
    '--on-demand',
    '--port', String(port),
    '--config', configPath,
  ]);
  assert.equal(connected.status, 0, connected.stderr);
  assert.match(connected.stdout, /On-demand consent configured/);

  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  const args = config.mcpServers.uomp.args;
  assert.ok(args.includes('--on-demand'));
  assert.ok(args.includes('--request-scope'));
  assert.equal(existsSync(envPath), false);

  const mcp = startMcp(home, envPath, port);
  t.after(() => mcp.kill());

  const init = await mcp.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'on-demand-test', version: '0.0.0' },
  });
  assert.equal(init.result.serverInfo.name, 'uomp');

  const first = await mcp.request('tools/call', {
    name: 'list_memory',
    arguments: { tag: 'notes/projects' },
  });
  const firstText = first.result.content[0].text;
  assert.equal(first.result.isError, true);
  assert.match(firstText, /uomp approve consent_/);

  const requestId = /uomp approve (consent_[A-Za-z0-9_]+)/.exec(firstText)[1];
  const pending = JSON.parse(runCli(home, ['pending', '--json']).stdout);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].requestId, requestId);

  const approved = runCli(home, ['approve', requestId]);
  assert.equal(approved.status, 0, approved.stderr);
  assert.ok(existsSync(envPath));
  assert.deepEqual(JSON.parse(runCli(home, ['pending', '--json']).stdout), []);

  const second = await mcp.request('tools/call', {
    name: 'list_memory',
    arguments: { tag: 'notes/projects' },
  });
  assert.equal(second.result.isError, false);
  assert.match(second.result.content[0].text, /note\.projects\.plan/);

  await mcp.close();
});

test('denying an on-demand request lets the next call create a new request', async t => {
  const home = mkdtempSync(join(tmpdir(), 'uomp-on-demand-deny-'));
  const vault = join(home, 'vault');
  const configPath = join(home, 'claude.json');
  const envPath = join(home, '.uomp', 'sessions', 'claude.env');
  const port = await getFreePort();

  mkdirSync(join(vault, 'projects'), { recursive: true });
  writeFileSync(join(vault, 'projects', 'plan.md'), '# Plan\nShip it.\n');

  t.after(async () => {
    runCli(home, ['stop']);
    rmSync(home, { recursive: true, force: true });
  });

  const connected = runCli(home, [
    'connect', 'claude',
    '--vault', vault,
    '--scope', 'notes/projects',
    '--on-demand',
    '--port', String(port),
    '--config', configPath,
  ]);
  assert.equal(connected.status, 0, connected.stderr);

  const mcp = startMcp(home, envPath, port);
  t.after(() => mcp.kill());

  await mcp.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'on-demand-test', version: '0.0.0' },
  });

  const first = await mcp.request('tools/call', {
    name: 'list_memory',
    arguments: { tag: 'notes/projects' },
  });
  const firstId = /uomp approve (consent_[A-Za-z0-9_]+)/.exec(first.result.content[0].text)?.[1];
  assert.ok(firstId);

  const denied = runCli(home, ['deny', firstId]);
  assert.equal(denied.status, 0, denied.stderr);
  assert.deepEqual(JSON.parse(runCli(home, ['pending', '--json']).stdout), []);

  const second = await mcp.request('tools/call', {
    name: 'list_memory',
    arguments: { tag: 'notes/projects' },
  });
  const secondId = /uomp approve (consent_[A-Za-z0-9_]+)/.exec(second.result.content[0].text)?.[1];
  assert.ok(secondId);
  assert.notEqual(secondId, firstId);

  await mcp.close();
});
