const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { fork } = require('node:child_process');
const { setTimeout: pause } = require('node:timers/promises');
const extension = process.env.MOCHA_EXTENSION_ROOT;
async function port() {
 const server = net.createServer();
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const result = server.address().port; await new Promise(resolve => server.close(resolve)); return result;
}
function running(pid) {
 try {
  process.kill(pid, 0);
  // Linux containers can leave a reparented zombie until init reaps it.
  if (process.platform === 'linux' && /\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false;
  return true;
 } catch (error) { if (error.code === 'ESRCH' || error.code === 'ENOENT') return false; throw error; }
}
for (const action of ['loadTests', 'runTests']) for (const cancellation of ['signal', 'disconnect']) {
 test(`NYC ${action} ${cancellation} stops its worker and a grandchild that ignores SIGTERM`, { skip: !extension, timeout: 20000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc-cancel-'));
  const pidFile = path.join(directory, 'pids.json');
  const readyFile = path.join(directory, 'grandchild-ready');
  const grandchild = `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(readyFile)}, 'ready');setInterval(()=>{},1000);`;
  const occupied = await port();
  const workerPort = await port();
  const testFile = path.join(directory, 'test.js');
  fs.writeFileSync(testFile, `const fs = require('fs'); const cp = require('child_process'); const net = require('net');
const child = cp.spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio:'ignore'});
const server = net.createServer(); server.listen(${occupied}, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid])));
describe('cancel', () => it('waits', done => { setInterval(()=>{},1000); }));`);
  const launcher = fork(path.resolve(__dirname, '../nyc/index.js'), [], {
   silent: true, env: { ...process.env, MOCHA_WORKER_IPC_MODULE: extension + '/out/secureIpc.js',
    MOCHA_WORKER_IPC_KEY: require(extension + '/out/secureIpc.js').createIpcKey(), NYC_PORT: String(workerPort),
    NYC_PATH: path.resolve(__dirname, '../node_modules/nyc/bin/nyc.js') }
  });
  let output = ''; launcher.stderr.on('data', data => output += data); launcher.stdout.resume();
  const exited = new Promise(resolve => launcher.once('exit', resolve));
  let pids = [];
  try {
   launcher.send({ action, cwd: directory, testFiles: [testFile], tests: ['cancel waits'], env: {},
    mochaPath: extension + '/node_modules/mocha', workerScript: extension + '/out/worker/bundle.js',
    mochaOpts: { ui: 'bdd', timeout: 600000, retries: 0, requires: [], delay: false, fullTrace: false, exit: false, asyncOnly: false, parallel: false },
    monkeyPatch: true, esmLoader: true, logEnabled: false });
   const deadline = Date.now() + 10000;
   while ((!fs.existsSync(pidFile) || !fs.existsSync(readyFile)) && launcher.exitCode === null && Date.now() < deadline) await pause(50);
   assert.ok(fs.existsSync(pidFile) && fs.existsSync(readyFile), 'Worker and stubborn grandchild did not start: ' + output);
   pids = JSON.parse(fs.readFileSync(pidFile));
   assert.ok(pids.every(running));
   if (cancellation === 'signal') launcher.kill(); else launcher.disconnect();
   const result = await Promise.race([exited, pause(5000).then(() => { throw new Error('Cancellation did not finish: ' + output); })]);
   assert.equal(result, 1);
   const stopped = Date.now() + 3000;
   while (pids.some(running) && Date.now() < stopped) await pause(50);
   assert.ok(pids.every(pid => !running(pid)), 'A worker or grandchild survived cancellation');
   const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(occupied, '127.0.0.1', resolve); });
   await new Promise(resolve => server.close(resolve));
  } finally {
   launcher.kill();
   for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
   fs.rmSync(directory, { recursive: true, force: true });
  }
 });
}
