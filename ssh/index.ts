import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { mochaWorker } from 'vscode-test-adapter-remoting-util';
import { secureTransport, port, mapPath, quote, sshDestination, supervise, bridge, fail } from '../shared/security';

process.once('message', async (original: any) => {
	let child;
	let stop: (() => Promise<void>) | undefined;
	try {
		const { transport, key } = secureTransport();
		const destination = sshDestination(process.env.SSH_HOST, process.env.SSH_USER);
		const local = process.env.VSCODE_WORKSPACE_PATH || process.cwd();
		const remote = process.env.SSH_WORKSPACE_PATH;
		if (!remote || !remote.startsWith('/')) throw new Error('An absolute SSH_WORKSPACE_PATH is required');
		const workerPort = port(process.env.SSH_WORKER_PORT);
		const convert = (value: string) => mapPath(value, local, remote);
		const args = mochaWorker.convertWorkerArgs(original, convert);
		// Bundled Mocha lives outside the workspace and is not copied by rsync.
		if (args.mochaPath === original.mochaPath) args.mochaPath = process.env.SSH_MOCHA_PATH || remote + '/node_modules/mocha';
		if (args.mochaOpts.requires) args.mochaOpts.requires = args.mochaOpts.requires.map(convert);
		const debugPort = args.debuggerPort ? port(String(args.debuggerPort)) : undefined;
		child = spawn('rsync', ['-r', '--protect-args', '-e', 'ssh -o BatchMode=yes', '--', local + '/', destination + ':' + remote], {
			stdio: 'inherit', detached: process.platform !== 'win32'
		});
		stop = supervise(child, true);
		await new Promise<void>((resolve, reject) => {
			child!.once('error', reject);
			child!.once('close', (code: number | null) => code === 0 ? resolve() : reject(new Error('Workspace synchronization failed')));
		});
		const connection = transport.receiveSecureConnection(workerPort, { host: '127.0.0.1', key });
		connection.catch(() => {});
		const command = [process.env.SSH_NODE_PATH || 'node', ...(debugPort ? [`--inspect-brk=127.0.0.1:${debugPort}`] : []), '-',
			JSON.stringify({ role: 'client', port: workerPort, host: '127.0.0.1' })].map(quote).join(' ');
		child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
			'-R', `127.0.0.1:${workerPort}:127.0.0.1:${workerPort}`,
			...(debugPort ? ['-L', `127.0.0.1:${debugPort}:127.0.0.1:${debugPort}`] : []), destination, command
		], { stdio: ['pipe', 'inherit', 'inherit'], detached: process.platform !== 'win32' });
		stop = supervise(child, true);
		child.stdin!.on('error', () => { void stop!().then(fail, fail); });
		// Deliver the secret over the encrypted SSH stdin channel, never argv.
		child.stdin!.end(`process.env.MOCHA_WORKER_IPC_KEY = ${JSON.stringify(key)};\n` + readFileSync(original.workerScript, 'utf8'));
		await bridge(await connection, args, transport, child, stop, (message: any) => {
			const reverse = (value: string) => mapPath(value, remote, local);
			return args.action === 'loadTests' ? mochaWorker.convertTestLoadMessage(message, reverse) : mochaWorker.convertTestRunMessage(message, reverse);
		});
	} catch { if (stop) await stop(); else child?.kill(); fail(); }
});
