import { ChildProcess } from 'child_process';
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
export function supervise(child: ChildProcess): void {
	child.once('error', fail);
	child.once('exit', (code, signal) => { if (code || signal) fail(); });
	process.once('disconnect', () => child.kill());
	process.once('SIGTERM', () => { child.kill(); process.exit(1); });
}
export function forward(message: any, done: () => void = () => {}): void {
	if (!process.connected) return done();
	process.send!(message, error => { if (error) fail(); done(); });
}
export async function bridge(socket: TLSSocket, args: any, transport: any, child: ChildProcess, convert: (message: any) => any = message => message): Promise<void> {
	let pending = 0;
	let ended = false;
	let childEnded = child.exitCode !== null;
	const finish = () => { if (ended && childEnded && !pending && process.connected) process.disconnect(); };
	child.once('close', () => { childEnded = true; finish(); });
	socket.once('error', () => { child.kill(); fail(); });
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
