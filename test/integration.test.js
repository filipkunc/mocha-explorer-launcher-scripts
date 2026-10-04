const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { fork } = require('node:child_process');
const extension = process.env.MOCHA_EXTENSION_ROOT;
const enabled = Boolean(extension);
async function freePort() {
 const server = net.createServer();
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const port = server.address().port;
 await new Promise(resolve => server.close(resolve));
 return port;
}
async function launch(name, args, env) {
 const child = fork(path.resolve(__dirname, '../' + name + '/index.js'), [], {
  env: { ...process.env, MOCHA_WORKER_IPC_MODULE: path.join(extension, 'out/secureIpc.js'),
   MOCHA_WORKER_IPC_KEY: require(path.join(extension, 'out/secureIpc.js')).createIpcKey(), ...env },
  silent: true
 });
 const messages = []; let output = '';
 child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
 const ended = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => { child.kill(); reject(new Error('Launcher timed out: ' + output)); }, 60000);
  child.once('error', reject);
  child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('Launcher exit ' + code + ': ' + output)); });
 });
 child.on('message', message => messages.push(message));
 child.send(args);
 await ended;
 assert.ok(!messages.some(message => message && message.type === 'error'), JSON.stringify(messages));
 return messages;
}
for (const name of ['nyc', 'ssh', 'docker']) {
 test(name + ' discovers and runs real tests without leaking the transport key', { skip: !enabled || (name === 'docker' && !process.env.MOCHA_TEST_DOCKER), timeout: 150000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "launcher space'"));
  try {
   const testFile = path.join(directory, 'test.js');
   fs.writeFileSync(testFile, "const assert = require('assert'); describe('secure', () => { it('passes', () => assert.equal(process.env.MOCHA_WORKER_IPC_KEY, undefined)); });");
   const args = {
    action: 'loadTests', cwd: directory, testFiles: [testFile], env: {},
    mochaPath: path.join(extension, 'node_modules/mocha'), workerScript: path.join(extension, 'out/worker/bundle.js'),
    mochaOpts: { ui: 'bdd', timeout: 2000, retries: 0, requires: [], delay: false, fullTrace: false, exit: true, asyncOnly: false, parallel: false },
    monkeyPatch: true, multiFileSuites: false, esmLoader: true, logEnabled: false
   };
   const port = String(await freePort());
   const env = { VSCODE_WORKSPACE_PATH: directory, NYC_PORT: port, SSH_WORKER_PORT: port, DOCKER_WORKER_PORT: port };
   if (name === 'nyc') env.NYC_PATH = path.resolve(__dirname, '../node_modules/.bin/nyc');
   if (name === 'docker') { env.DOCKER_IMAGE = 'docker.io/library/node:24-slim'; env.DOCKER_EXTRA_ARGS = '["--security-opt","label=disable"]'; }
   if (name === 'ssh') {
    // Exercise the exact remote shell command and stdin bootstrap locally.
    const bin = path.join(directory, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'rsync'), '#!/usr/bin/env node\nrequire("fs").writeFileSync(process.env.RSYNC_CAPTURE, JSON.stringify(process.argv.slice(2)));');
    fs.writeFileSync(path.join(bin, 'ssh'), '#!/usr/bin/env node\nconst cp=require("child_process");const args=process.argv.slice(2);require("fs").writeFileSync(process.env.SSH_CAPTURE, JSON.stringify(args));const child=cp.spawn("/bin/sh",["-c",args.at(-1)],{stdio:"inherit"});child.on("exit",code=>process.exit(code));');
    fs.chmodSync(path.join(bin, 'rsync'), 0o755); fs.chmodSync(path.join(bin, 'ssh'), 0o755);
    Object.assign(env, { PATH: bin + path.delimiter + process.env.PATH, SSH_HOST: 'test-host', SSH_WORKSPACE_PATH: directory,
     SSH_NODE_PATH: process.execPath, SSH_MOCHA_PATH: args.mochaPath, RSYNC_CAPTURE: path.join(directory, 'rsync.json'), SSH_CAPTURE: path.join(directory, 'ssh.json') });
   }
   const loaded = await launch(name, args, env);
   const suite = loaded.find(message => message && message.type === 'suite');
   assert.ok(suite, JSON.stringify(loaded));
   assert.equal(suite.children[0].children[0].file, testFile);
   const results = await launch(name, { ...args, action: 'runTests', tests: ['secure passes'] }, env);
   assert.ok(results.some(message => message && message.type === 'test' && message.state === 'passed'), JSON.stringify(results));
   if (name === 'nyc') assert.ok(fs.existsSync(path.join(directory, 'coverage/lcov.info')));
   if (name === 'ssh') {
    const sync = JSON.parse(fs.readFileSync(env.RSYNC_CAPTURE));
    assert.ok(sync.includes('--protect-args')); assert.ok(sync.includes(directory + '/'));
    const ssh = JSON.parse(fs.readFileSync(env.SSH_CAPTURE));
    assert.ok(ssh.includes('127.0.0.1:' + port + ':127.0.0.1:' + port));
    assert.ok(!ssh.join(' ').includes('MOCHA_WORKER_IPC_KEY'));
   }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
 });
}
