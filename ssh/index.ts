import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync } from 'fs';
import { mochaWorker } from 'vscode-test-adapter-remoting-util';
import { secureTransport, port, mapPath, quote, sshDestination, supervise, bridge, fail } from '../shared/security';

process.once('message', async (original: any) => {
	let child;
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
		await promisify(execFile)('rsync', ['-r', '--protect-args', '-e', 'ssh -o BatchMode=yes', '--', local + '/', destination + ':' + remote]);
		const connection = transport.receiveSecureConnection(workerPort, { host: '127.0.0.1', key });
		connection.catch(() => {});
		const command = [process.env.SSH_NODE_PATH || 'node', ...(debugPort ? [`--inspect-brk=127.0.0.1:${debugPort}`] : []), '-',
			JSON.stringify({ role: 'client', port: workerPort, host: '127.0.0.1' })].map(quote).join(' ');
		child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
			'-R', `127.0.0.1:${workerPort}:127.0.0.1:${workerPort}`,
			...(debugPort ? ['-L', `127.0.0.1:${debugPort}:127.0.0.1:${debugPort}`] : []), destination, command
		], { stdio: ['pipe', 'inherit', 'inherit'] });
		supervise(child);
		child.stdin!.on('error', fail);
		// Deliver the secret over the encrypted SSH stdin channel, never argv.
		child.stdin!.end(`process.env.MOCHA_WORKER_IPC_KEY = ${JSON.stringify(key)};\n` + readFileSync(original.workerScript, 'utf8'));
		await bridge(await connection, args, transport, child, (message: any) => {
			const reverse = (value: string) => mapPath(value, remote, local);
			return args.action === 'loadTests' ? mochaWorker.convertTestLoadMessage(message, reverse) : mochaWorker.convertTestRunMessage(message, reverse);
		});
	} catch { child?.kill(); fail(); }
});
