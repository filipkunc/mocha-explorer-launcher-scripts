import { spawn } from 'child_process';
import * as path from 'path';
import { mochaWorker } from 'vscode-test-adapter-remoting-util';
import { secureTransport, port, stringArray, mapPath, supervise, bridge, fail, containerConnection } from '../shared/security';

process.once('message', async (original: any) => {
	let child;
	let stop: (() => Promise<void>) | undefined;
	try {
		const { transport, key } = secureTransport();
		const image = process.env.DOCKER_IMAGE || 'node:24-bookworm-slim';
		if (image.startsWith('-')) throw new Error('Invalid Docker image');
		const local = process.env.VSCODE_WORKSPACE_PATH || process.cwd();
		const remote = process.env.DOCKER_WORKSPACE_PATH || '/workspace';
		const worker = process.env.DOCKER_WORKER_PATH || '/worker.js';
		const extension = path.dirname(path.dirname(process.env.MOCHA_WORKER_IPC_MODULE!));
		const extensionMount = '/mocha-explorer';
		const workerPort = port(process.env.DOCKER_WORKER_PORT);
		const toRemote = (value: string) => mapPath(mapPath(value, local, remote), extension, extensionMount);
		const args = mochaWorker.convertWorkerArgs(original, toRemote);
		if (args.mochaOpts.requires) args.mochaOpts.requires = args.mochaOpts.requires.map(toRemote);
		const debugPort = args.debuggerPort ? port(String(args.debuggerPort)) : undefined;
		child = spawn('docker', [
			'run', '--rm', '-v', `${local}:${remote}`, '-v', `${original.workerScript}:${worker}:ro`,
			'-v', `${extension}:${extensionMount}:ro`, '--env', 'MOCHA_WORKER_IPC_KEY',
			'-p', `127.0.0.1:${workerPort}:${workerPort}`,
			...(debugPort ? ['-p', `127.0.0.1:${debugPort}:${debugPort}`] : []),
			...stringArray(process.env.DOCKER_EXTRA_ARGS), image, 'node',
			...(debugPort ? [`--inspect-brk=0.0.0.0:${debugPort}`] : []), worker,
			JSON.stringify({ role: 'server', port: workerPort, host: '0.0.0.0' })
		], { stdio: 'inherit', detached: process.platform !== 'win32' });
		stop = supervise(child, true);
		const socket = await containerConnection(transport, workerPort, key);
		await bridge(socket, args, transport, child, stop, (message: any) => {
			const convert = (value: string) => mapPath(value, remote, local);
			return args.action === 'loadTests' ? mochaWorker.convertTestLoadMessage(message, convert) : mochaWorker.convertTestRunMessage(message, convert);
		});
	} catch { if (stop) await stop(); else child?.kill(); fail(); }
});
