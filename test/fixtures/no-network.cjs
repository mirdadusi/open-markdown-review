// Used only by the offline-authoring test child, never installed in a client.
const deny = () => { throw new Error('Offline qualification forbids network access and child-process authentication.'); };
globalThis.fetch = deny;
for (const name of ['node:http', 'node:https']) {
  const module = require(name); module.request = deny; module.get = deny;
}
require('node:net').Socket.prototype.connect = deny;
const child = require('node:child_process');
for (const name of ['exec', 'execFile', 'spawn', 'execSync', 'execFileSync', 'spawnSync']) child[name] = deny;
