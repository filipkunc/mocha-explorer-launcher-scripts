const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('--integration') && !process.env.MOCHA_EXTENSION_ROOT) {
 throw new Error('MOCHA_EXTENSION_ROOT must point to the built hardened extension');
}
const files = fs.readdirSync(__dirname).filter(file => file.endsWith('.test.js')).sort().map(file => path.join(__dirname, file));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exit(result.status === null ? 1 : result.status);
