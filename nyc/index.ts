import * as path from 'path';
import { fork, spawn } from 'child_process';
import { secureTransport, port, supervise, bridge, forward, fail } from '../shared/security';

process.once('message', async (args: any) => {
	let child;
	let stop: (() => Promise<void>) | undefined;
	try {
		const { transport, key } = secureTransport();
		process.chdir(args.cwd);
		if (args.action === 'runTests' && !args.debuggerPort) {
			const workerPort = port(process.env.NYC_PORT);
			const connection = transport.receiveSecureConnection(workerPort, { host: '127.0.0.1', key });
			// Attach rejection handling before starting the process.
			connection.catch(() => {});
			const coveragePath = process.env.NYC_PATH
				? path.resolve(args.cwd, process.env.NYC_PATH)
				: require.resolve('nyc/bin/nyc.js', { paths: [args.cwd] });
			const nodeScript = path.extname(coveragePath) === '.js';
			child = spawn(nodeScript ? process.execPath : coveragePath, [
				...(nodeScript ? [coveragePath] : []),
				`--reporter=${process.env.NYC_REPORTER || 'lcov'}`, process.execPath, args.workerScript,
				JSON.stringify({ role: 'client', port: workerPort, host: '127.0.0.1' })
			], { stdio: 'inherit', detached: process.platform !== 'win32' });
			stop = supervise(child, true);
			await bridge(await connection, args, transport, child, stop);
		} else {
			child = fork(args.workerScript, [], {
				execArgv: args.debuggerPort ? [`--inspect-brk=127.0.0.1:${port(String(args.debuggerPort))}`] : [],
				detached: process.platform !== 'win32',
				stdio: ['ignore', 'inherit', 'inherit', 'ipc']
			});
			stop = supervise(child, true);
			let pending = 0; let ended = false;
			const finish = () => { if (ended && !pending && process.connected) process.disconnect(); };
			child.on('message', message => { pending++; forward(message, () => { pending--; finish(); }); });
			child.once('close', () => { ended = true; finish(); });
			child.send(args);
		}
	} catch { if (stop) await stop(); else child?.kill(); fail(); }
});
