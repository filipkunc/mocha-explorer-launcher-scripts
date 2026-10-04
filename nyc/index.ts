import * as path from 'path';
import { fork, spawn } from 'child_process';
import { secureTransport, port, supervise, bridge, forward, fail } from '../shared/security';

process.once('message', async (args: any) => {
	let child;
	try {
		const { transport, key } = secureTransport();
		process.chdir(args.cwd);
		if (args.action === 'runTests' && !args.debuggerPort) {
			const workerPort = port(process.env.NYC_PORT);
			const connection = transport.receiveSecureConnection(workerPort, { host: '127.0.0.1', key });
			// Attach rejection handling before starting the process.
			connection.catch(() => {});
			child = spawn(path.resolve(args.cwd, process.env.NYC_PATH || 'node_modules/.bin/nyc'), [
				`--reporter=${process.env.NYC_REPORTER || 'lcov'}`, process.execPath, args.workerScript,
				JSON.stringify({ role: 'client', port: workerPort, host: '127.0.0.1' })
			], { stdio: 'inherit' });
			supervise(child);
			await bridge(await connection, args, transport, child);
		} else {
			child = fork(args.workerScript, [], {
				execArgv: args.debuggerPort ? [`--inspect-brk=127.0.0.1:${port(String(args.debuggerPort))}`] : [],
				stdio: ['ignore', 'inherit', 'inherit', 'ipc']
			});
			supervise(child);
			let pending = 0; let ended = false;
			const finish = () => { if (ended && !pending && process.connected) process.disconnect(); };
			child.on('message', message => { pending++; forward(message, () => { pending--; finish(); }); });
			child.once('close', () => { ended = true; finish(); });
			child.send(args);
		}
	} catch { child?.kill(); fail(); }
});
