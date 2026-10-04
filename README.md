# Secure launcher scripts for Mocha Test Explorer

This fork migrates Docker, SSH, NYC coverage and VS Code integration launchers to the authenticated, encrypted worker protocol in the [hardened Mocha Test Explorer fork](https://github.com/filipkunc/vscode-mocha-test-adapter). These launchers require that extension; upstream extension and launcher 0.4 are incompatible with the new protocol.

Use **Node 24 LTS** for development and remote workers. Node 22.12+ and Node 26 also work; Node 20 and odd-numbered releases are unsupported. VS Code 1.102+ supplies a compatible Node 22 runtime. Changing a shell's Node version does not change VS Code's bundled runtime; use `mochaExplorer.nodePath` to select an external Node executable when needed.

## Build and install

Version 0.5 is a fork build, not a release on npm. Build a tarball and install it in your test workspace:

```sh
git clone https://github.com/filipkunc/mocha-explorer-launcher-scripts.git
cd mocha-explorer-launcher-scripts
git switch security/secure-launchers-node24
nvm use
npm ci
npm test
npm pack
# Run in the workspace containing your tests:
npm install --save-dev /absolute/path/mocha-explorer-launcher-scripts-0.5.0.tgz
```

Install the matching hardened extension VSIX. Select a launcher in `.vscode/settings.json`; configuration below assumes the package is in workspace `node_modules`.

## Docker

```json
{
  "mochaExplorer.launcherScript": "node_modules/mocha-explorer-launcher-scripts/docker",
  "mochaExplorer.env": { "DOCKER_IMAGE": "node:24-bookworm-slim" }
}
```

The workspace is mounted at `/workspace`. Worker code and the extension's bundled dependencies are mounted read-only. Worker and debugger ports are published on host `127.0.0.1`; the worker listens inside the container on `0.0.0.0` so port forwarding works. Choose a free `DOCKER_WORKER_PORT` (default 8123). `DOCKER_WORKSPACE_PATH`, `DOCKER_WORKER_PATH` and a JSON string array in `DOCKER_EXTRA_ARGS` customize the container. Extra arguments are trusted configuration and can change container isolation or networking. On SELinux systems, provide suitable mount labels or an appropriate container policy. The connection allows up to 60 seconds for container startup; pull the image before discovery.

The launch key is passed by environment variable name, never its value in command arguments. Docker administrators can inspect container environments, so the daemon remains a trusted component.

## SSH

```json
{
  "mochaExplorer.launcherScript": "node_modules/mocha-explorer-launcher-scripts/ssh",
  "mochaExplorer.env": {
    "SSH_HOST": "test-host.example.org",
    "SSH_USER": "runner",
    "SSH_WORKSPACE_PATH": "/home/runner/project",
    "SSH_NODE_PATH": "/home/runner/.nvm/versions/node/v24.21.0/bin/node"
  }
}
```

Configure key-based SSH login and verify the host key before running tests. Both SSH and rsync use batch mode; SSH requires forwarding to succeed. The remote workspace path must be absolute. Install compatible project dependencies and **Mocha 12** on the remote host; the extension's local Mocha installation is not copied. `SSH_MOCHA_PATH` selects a remote Mocha package (default `<remote workspace>/node_modules/mocha` when local Mocha is outside the workspace). Native dependencies must match the remote platform; rsync copies the workspace recursively, so avoid syncing incompatible local `node_modules`.

`SSH_WORKER_PORT` defaults to 8123 and must be free locally and remotely. Worker and debugger tunnels bind to loopback on both hosts. The script and ephemeral key travel through encrypted SSH stdin, with no key in command arguments or a temporary remote file. Workspace paths go to rsync as separate protected arguments; every remote Node argument is shell-quoted. SSH host aliases work, but SSH configuration should supply nonstandard ports and authentication options.

## NYC coverage

Install a patched NYC version (18+) in the test workspace:

```sh
npm install --save-dev nyc@^18
```

```json
{ "mochaExplorer.launcherScript": "node_modules/mocha-explorer-launcher-scripts/nyc" }
```

With `exit` enabled, workers flush their final result and exit normally even if tests leave timers or servers open, allowing NYC to write coverage. Cancellation stops detached process groups on POSIX and uses `taskkill /T` on Windows, including instrumentation descendants; killing the IPC/TCP connection also stops standalone workers. Embedded VS Code workers leave process lifetime to their host.

Discovery and debugging use native Node IPC; test runs use an encrypted loopback connection under NYC. `NYC_PATH` selects the NYC executable or Node `.js` entrypoint (use the `.js` entrypoint on Windows), `NYC_REPORTER` defaults to `lcov`, and `NYC_PORT` defaults to 8123. The launcher drains worker messages and waits for the coverage process to finish before exiting.

## VS Code integration tests

```json
{
  "mochaExplorer.launcherScript": "node_modules/mocha-explorer-launcher-scripts/vscode-test",
  "mochaExplorer.ipcRole": "server",
  "mochaExplorer.env": { "VSCODE_VERSION": "stable" }
}
```

The launcher uses `@vscode/test-electron` 3.1 as a runtime dependency and explicitly forwards the key, worker path and IPC settings to the test extension host. Numeric `VSCODE_VERSION` values must be 1.102 or newer. `VSCODE_LAUNCH_ARGS` accepts a JSON string array. The downloaded VS Code needs a working graphical display or a headless display setup.

## Validation

`npm test` builds the scripts and checks validation, shell quoting, workspace boundaries, credential rejection and the VS Code environment handoff. To run real workers against a built checkout of the hardened extension:

```sh
MOCHA_EXTENSION_ROOT=/absolute/path/vscode-mocha-test-adapter npm test
# Include a real Docker-compatible container run (pull node:24-slim first):
MOCHA_EXTENSION_ROOT=/absolute/path/vscode-mocha-test-adapter MOCHA_TEST_DOCKER=1 npm test
```

SSH integration tests execute the generated remote command and stdin bootstrap locally using simulated SSH/rsync executables. They do not verify authentication, host keys or forwarding on a deployed remote server. VS Code launcher tests mock its downloader/API and verify the environment handoff; a full graphical VS Code launch needs a display.

## Required CI

The `CI gate` check is required before merging into `master`. Node 22.12, 24 and 26 are tested on Linux, Windows and macOS against a built checkout of the hardened extension. Linux additionally runs real Node 24 container tests; Windows skips POSIX SSH shell simulations. All platforms exercise NYC keepalive and cancellation, including a grandchild that ignores SIGTERM. Dependency audit and tarball packaging are also required. `npm run test:integration` fails if `MOCHA_EXTENSION_ROOT` is missing, preventing a green integration job that accidentally skipped every worker regression. The matching extension fork has its own required gate and launcher integration job.
