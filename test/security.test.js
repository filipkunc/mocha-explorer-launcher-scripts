const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, fork } = require('node:child_process');
const path = require('node:path');
const { port, stringArray, mapPath, quote, sshDestination } = require('../shared/security');

test('rejects malformed ports, launcher arguments and SSH destinations', () => {
 for (const value of ['', 'abc', '8123junk', '0', '-1', '65536', '1.5']) assert.throws(() => port(value));
 for (const value of ['{}', 'null', '[1]', '["ok",false]']) assert.throws(() => stringArray(value));
 for (const value of ['-oProxyCommand=bad', 'host;touch file', 'user@host', 'host with spaces']) assert.throws(() => sshDestination(value));
 assert.equal(sshDestination('example.org', 'runner'), 'runner@example.org');
});
test('quotes shell metacharacters as literal remote command arguments', { skip: process.platform === 'win32' }, () => {
 for (const value of ["a'b", 'workspace with spaces', '$(printf injected)', '`printf injected`', '; printf injected', 'line\nnext']) {
  const result = execFileSync('/bin/sh', ['-c', 'printf %s ' + quote(value)], { encoding: 'utf8' });
  assert.equal(result, value);
 }
});
test('maps only complete workspace path segments', () => {
 assert.equal(mapPath('/work/test/a.js', '/work', '/remote'), '/remote/test/a.js');
 assert.equal(mapPath('/work-other/a.js', '/work', '/remote'), '/work-other/a.js');
 assert.equal(mapPath('C:\\work\\test.js', 'C:\\work', '/remote'), '/remote/test.js');
});
test('fails closed without secure credentials and does not print secret env values', async () => {
 const secret = 'SECRET-MUST-NOT-APPEAR';
 const child = fork(path.resolve(__dirname, '../docker/index.js'), [], {
  env: { ...process.env, MOCHA_WORKER_IPC_KEY: secret, MOCHA_WORKER_IPC_MODULE: '' },
  silent: true
 });
 let output = ''; child.stderr.on('data', data => output += data);
 const result = new Promise(resolve => child.on('exit', resolve));
 child.send({ action: 'loadTests' });
 assert.equal(await result, 1);
 assert.ok(!output.includes(secret));
});

test('VS Code launcher forwards secure credentials and rejects an obsolete host', async () => {
 const fs = require('node:fs'); const os = require('node:os');
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-launcher-'));
 try {
  const capture = path.join(directory, 'options.json');
  const preload = path.join(directory, 'preload.js');
  const transport = path.join(directory, 'transport.js');
  fs.writeFileSync(transport, 'module.exports = {};');
  fs.writeFileSync(preload, `const Module=require('module');const original=Module._load;Module._load=function(name,...args){return name==='@vscode/test-electron'?{runTests:async options=>{if(process.env.ELECTRON_RUN_AS_NODE)throw new Error('Electron flag leaked');require('fs').writeFileSync(process.env.CAPTURE,JSON.stringify(options))}}:original.call(this,name,...args)};`);
  const key = 'ab'.repeat(32);
  const env = { ...process.env, MOCHA_WORKER_IPC_KEY: key, MOCHA_WORKER_IPC_MODULE: transport,
   MOCHA_WORKER_PATH: '/worker.js', VSCODE_WORKSPACE_PATH: directory, CAPTURE: capture, VSCODE_VERSION: '1.102.0', ELECTRON_RUN_AS_NODE: '1' };
  const executable = path.resolve(__dirname, '../vscode-test/index.js');
  const options = JSON.stringify({ role: 'client', port: 8123 });
  execFileSync(process.execPath, ['-r', preload, executable, options], { env });
  const result = JSON.parse(fs.readFileSync(capture));
  assert.equal(result.extensionTestsEnv.MOCHA_WORKER_IPC_KEY, key);
  assert.equal(result.extensionTestsEnv.MOCHA_WORKER_PATH, '/worker.js');
  assert.equal(result.extensionTestsEnv.MOCHA_WORKER_IPC_HOST, '127.0.0.1');
  assert.throws(() => execFileSync(process.execPath, ['-r', preload, executable, options], {
   env: { ...env, VSCODE_VERSION: '1.101.0' }, stdio: 'pipe'
  }));
 } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
