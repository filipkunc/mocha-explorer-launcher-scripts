import { runTests } from '@vscode/test-electron';
import { secureTransport, port, stringArray, fail } from '../shared/security';

(async () => {
	try {
		const { key } = secureTransport();
		const options = JSON.parse(process.argv[2]);
		if (options.role !== 'client' && options.role !== 'server') throw new Error('Invalid IPC role');
		const workerPort = port(String(options.port));
		const workspace = process.env.VSCODE_WORKSPACE_PATH;
		const worker = process.env.MOCHA_WORKER_PATH;
		if (!workspace || !worker) throw new Error('Missing worker paths');
		const version = process.env.VSCODE_VERSION;
		if (version && /^\d+\.\d+\.\d+$/.test(version)) {
			const [major, minor] = version.split('.').map(Number);
			if (major < 1 || (major === 1 && minor < 102)) throw new Error('VS Code 1.102+ is required');
		}
		// The launcher may itself run as Electron-as-Node; VS Code must start normally.
		delete process.env.ELECTRON_RUN_AS_NODE;
		await runTests({
			extensionDevelopmentPath: workspace, extensionTestsPath: require.resolve('./runMochaWorker'),
			version, launchArgs: stringArray(process.env.VSCODE_LAUNCH_ARGS),
			extensionTestsEnv: {
				MOCHA_WORKER_IPC_ROLE: options.role, MOCHA_WORKER_IPC_PORT: String(workerPort),
				MOCHA_WORKER_IPC_HOST: options.host || '127.0.0.1', MOCHA_WORKER_IPC_KEY: key,
				MOCHA_WORKER_PATH: worker
			}
		});
	} catch { fail(); }
})();
