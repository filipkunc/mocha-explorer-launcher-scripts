import { ChildProcess, spawn } from 'child_process';
import { TLSSocket } from 'tls';
import * as path from 'path';

export function port(value: string | undefined, fallback = 8123): number {
	const result = value === undefined ? fallback : Number(value);
	if (!Number.isInteger(result) || result < 1 || result > 65535) throw new Error('Invalid worker port');
	return result;
}
export function stringArray(value: string | undefined): string[] {
	const result = JSON.parse(value || '[]');
	if (!Array.isArray(result) || result.some(item => typeof item !== 'string')) throw new Error('Expected a JSON array of strings');
	return result;
}
export function secureTransport(): { transport: any; key: string } {
	const key = process.env.MOCHA_WORKER_IPC_KEY;
	const modulePath = process.env.MOCHA_WORKER_IPC_MODULE;
	if (!key || !/^[a-f0-9]{64}$/i.test(key) || !modulePath || !path.isAbsolute(modulePath)) throw new Error('Updated Mocha Test Explorer secure transport is required');
	return { transport: require(modulePath), key };
}
export function mapPath(value: string, from: string, to: string): string {
	const normalized = value.replace(/\\/g, '/');
	const prefix = from.replace(/\\/g, '/').replace(/\/$/, '');
	return normalized === prefix || normalized.startsWith(prefix + '/') ? to.replace(/\/$/, '') + normalized.slice(prefix.length) : value;
}
export function quote(value: string): string { return "'" + value.replace(/'/g, "'\"'\"'") + "'"; }
export function sshDestination(host: string | undefined, user: string | undefined): string {
	if (!host || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(host) || (user !== undefined && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(user))) throw new Error('Invalid SSH host or user');
	return user ? `${user}@${host}` : host;
}
export function fail(): void {
	console.error('Secure launcher failed; check configuration, remote dependencies and Node version');
	process.exit(1);
}
/** A detached POSIX group, or Windows taskkill /T, includes instrumentation descendants. */
export function supervise(child: ChildProcess, tree = false): () => Promise<void> {
	let stopping: Promise<void> | undefined;
	const stop = (): Promise<void> => {
		if (stopping) return stopping;
		stopping = (async () => {
			if (!child.pid) return;
			if (process.platform === 'win32' && tree) {
				if (child.exitCode !== null || child.signalCode !== null) return;
				await new Promise<void>(resolve => {
					const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
					killer.once('error', () => { child.kill(); resolve(); });
					killer.once('close', () => resolve());
				});
				return;
			}
			const signal = (name: NodeJS.Signals) => {
				try { tree ? process.kill(-child.pid!, name) : child.kill(name); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
			};
			signal('SIGTERM');
			if (child.exitCode === null && child.signalCode === null) {
				await new Promise<void>(resolve => {
					const timer = setTimeout(resolve, 2000);
					child.once('close', () => { clearTimeout(timer); resolve(); });
				});
			}
			// Also stop grandchildren that ignored SIGTERM or outlived their parent.
			if (tree) signal('SIGKILL');
		})();
		return stopping;
	};
	const cancel = () => { void stop().then(() => process.exit(1), fail); };
	process.once('disconnect', cancel);
	process.once('SIGTERM', cancel);
	process.once('SIGINT', cancel);
	child.once('error', () => { void stop().then(fail, fail); });
	child.once('exit', (code, signal) => {
		if (code || signal) { if (!stopping) void stop().then(fail, fail); }
		else if (tree) void stop().catch(fail);
	});
	child.once('close', () => {
		process.removeListener('disconnect', cancel);
		process.removeListener('SIGTERM', cancel);
		process.removeListener('SIGINT', cancel);
	});
	return stop;
}
export function forward(message: any, done: () => void = () => {}): void {
	if (!process.connected) return done();
	process.send!(message, error => { if (error) fail(); done(); });
}
export async function bridge(socket: TLSSocket, args: any, transport: any, child: ChildProcess, stop: () => Promise<void>, convert: (message: any) => any = message => message): Promise<void> {
	let pending = 0;
	let ended = false;
	let childEnded = child.exitCode !== null;
	const finish = () => { if (ended && childEnded && !pending && process.connected) process.disconnect(); };
	child.once('close', () => { childEnded = true; finish(); });
	socket.once('error', () => { void stop().then(fail, fail); });
	socket.once('close', () => { ended = true; finish(); });
	transport.readSecureMessages(socket, (message: any) => {
		pending++;
		forward(convert(message), () => { pending--; finish(); });
	});
	await transport.writeSecureMessage(socket, args);
}

export async function containerConnection(transport: any, workerPort: number, key: string): Promise<TLSSocket> {
	const deadline = Date.now() + 60000;
	while (true) {
		try { return await transport.createSecureConnection(workerPort, { host: '127.0.0.1', key, timeout: Math.max(1, deadline - Date.now()) }); }
		catch (error) {
			// Container port forwarding can accept and reset before Node starts listening.
			if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET' || Date.now() >= deadline) throw error;
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	}
}
