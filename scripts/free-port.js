#!/usr/bin/env node
import net from 'node:net';
import { execSync } from 'node:child_process';

/**
 * Free the dev port before `npm run dev` binds it.
 *
 * A watch-mode restart that dies mid-shutdown leaves the old process holding
 * the socket, and the next start fails with EADDRINUSE. This kills whatever is
 * on the port first.
 *
 * `npm start` deliberately does NOT run this — killing an unknown process is
 * fine on a laptop and completely unacceptable on a server, where the thing
 * holding the port might be the service you are about to replace.
 */

if (process.env.NODE_ENV === 'production') {
  console.error('✖ free-port refuses to run with NODE_ENV=production');
  process.exit(1);
}

const PORT = Number(process.env.PORT || 8100);

/** Is anything listening? Probe without a host so IPv4 and IPv6 both count. */
function inUse(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port);
  });
}

function pidsOn(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano -p tcp | findstr LISTENING | findstr :${port}`, { encoding: 'utf8' });
      return [...new Set(out.trim().split(/\r?\n/)
        .map((l) => l.trim().split(/\s+/).pop())
        .filter((pid) => pid && pid !== '0'))];
    }
    const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8' });
    return [...new Set(out.trim().split(/\r?\n/).filter(Boolean))];
  } catch {
    // Both commands exit non-zero when nothing matches — that is "no pids",
    // not a failure.
    return [];
  }
}

function kill(pid) {
  try {
    if (process.platform === 'win32') execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore' });
    else process.kill(Number(pid), 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

const busy = await inUse(PORT);
if (!busy) {
  console.log(`  ▸ port ${PORT} free`);
  process.exit(0);
}

const pids = pidsOn(PORT);
if (!pids.length) {
  // Held by another user's process, or by something the OS will not name.
  console.warn(`  ▸ port ${PORT} is busy but no PID could be identified — start may fail`);
  process.exit(0);
}

for (const pid of pids) {
  console.log(`  ▸ port ${PORT} held by PID ${pid} — stopping it`);
  if (!kill(pid)) console.warn(`  ▸ could not stop PID ${pid} (try running the terminal as administrator)`);
}

// The socket lingers briefly in TIME_WAIT after the process dies.
for (let i = 0; i < 20; i += 1) {
  if (!await inUse(PORT)) {
    console.log(`  ▸ port ${PORT} released`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 100));
}

console.warn(`  ▸ port ${PORT} still busy after 2s — starting anyway`);
