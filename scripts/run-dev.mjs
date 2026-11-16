import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiDirectory = path.join(root, 'LiquidVault.Api');
const project = path.join(apiDirectory, 'LiquidVault.Api.csproj');
const vite = path.join(root, 'node_modules/vite/bin/vite.js');
const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
const windows = process.platform === 'win32';
const options = new Set(process.argv.slice(2));
const allowed = new Set(['--help', '--local', '--lan', '--install', '--check']);
const children = new Set();
let stopping = false;
let stopPromise;

if (options.has('--help')) {
  console.log(`LiquidVault development launcher
Usage: bash run_linux.sh [options]
       bash run_windows.sh [options]        (Windows Git Bash)
       .\\run_windows.ps1 [options]           (PowerShell)

  --local    Bind both services to 127.0.0.1 (the default)
  --lan      Expose the UI/proxy on all interfaces for trusted-LAN use
  --install  Reinstall frontend dependencies from the lockfile
  --check    Install missing dependencies and build both apps without starting servers
  --help     Show this help

Requires Node.js 18+, npm, and the .NET 8 SDK/runtime.
API port: 5000. UI port: 5173. Ctrl+C stops this launcher's services.
LAN mode exposes the current shared, unauthenticated transfer board.
The current API has known security issues; keep the default local mode for review.`);
  process.exit(0);
}
for (const option of options) {
  if (!allowed.has(option)) {
    console.error(`Unknown option: ${option}. Use --help.`);
    process.exit(1);
  }
}

if (options.has('--local') && options.has('--lan')) {
  console.error('Choose either --local or --lan.');
  process.exit(1);
}

function start(command, args, cwd = root, npmCommand = false) {
  // cmd.exe runs only fixed npm arguments, without Node's shell concatenation mode.
  const executable = windows && npmCommand ? 'cmd.exe' : command;
  const commandArgs = windows && npmCommand ? ['/d', '/s', '/c', [command, ...args].join(' ')] : args;
  const child = spawn(executable, commandArgs, {
    cwd,
    stdio: 'inherit',
    detached: !windows,
    windowsHide: true,
    env: { ...process.env, ASPNETCORE_ENVIRONMENT: process.env.ASPNETCORE_ENVIRONMENT ?? 'Development', DOTNET_NOLOGO: '1', DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: '1' },
  });
  children.add(child);
  const done = new Promise((resolve) => {
    child.once('error', (error) => {
      console.error(`Cannot start ${command}: ${error.message}`);
      children.delete(child);
      resolve(1);
    });
    child.once('exit', (code) => {
      children.delete(child);
      resolve(code ?? 1);
    });
  });
  return { child, done };
}

async function run(command, args, cwd = root, npmCommand = false) {
  if (stopping) throw new Error('Startup interrupted.');
  const code = await start(command, args, cwd, npmCommand).done;
  if (stopping) throw new Error('Startup interrupted.');
  if (code !== 0) throw new Error(`${command} failed (exit ${code}). See the output above.`);
}

function signalTree(child, force = false) {
  if (!child.pid) return;
  if (windows) {
    // Only stop the process tree created by this launcher, never a port owner.
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true,
    });
  } else {
    try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
  }
}

function stop(code) {
  if (stopPromise) return stopPromise;
  stopping = true;
  process.exitCode = code;
  stopPromise = (async () => {
    const active = [...children];
    if (active.length) console.log('\nStopping LiquidVault services...');
    for (const child of active) signalTree(child);
    if (!windows && active.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      for (const child of active) signalTree(child, true);
    }
  })();
  return stopPromise;
}

process.on('SIGINT', () => { void stop(130); });
process.on('SIGTERM', () => { void stop(143); });
if (windows) process.on('SIGBREAK', () => { void stop(130); });

async function checkPort(port, host) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(
      `Port ${port} on ${host} is unavailable. Stop its existing service and try again; no existing process was stopped.`,
    )));
    server.listen(port, host, () => server.close(resolve));
  });
}

async function waitForService(url, service) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && !stopping) {
    if (service.child.exitCode !== null || service.child.signalCode !== null) {
      throw new Error(`Service exited before becoming ready: ${url}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch { /* Retry while the server starts. */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(stopping ? 'Startup interrupted.' : `Service was not ready within 60 seconds: ${url}`);
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('Node.js 18 or newer is required.');
  if (!existsSync(project)) throw new Error(`API project not found: ${project}`);
  await run('dotnet', ['--version']);
  const npm = windows ? 'npm.cmd' : 'npm';
  await run(npm, ['--version'], root, true);

  const host = options.has('--lan') ? '0.0.0.0' : '127.0.0.1';
  if (!options.has('--check')) {
    await checkPort(5000, '127.0.0.1');
    await checkPort(5173, host);
  }
  const npmShim = path.join(root, 'node_modules/.bin', windows ? 'tsc.cmd' : 'tsc');
  if (options.has('--install') || !existsSync(vite) || !existsSync(tsc) || !existsSync(npmShim)) {
    console.log('Installing frontend dependencies...');
    await run(npm, [existsSync(path.join(root, 'package-lock.json')) ? 'ci' : 'install', '--no-audit', '--no-fund'], root, true);
  }
  console.log('Building frontend...');
  await run(npm, ['run', 'build'], root, true);
  console.log('Building backend...');
  await run('dotnet', ['build', project, '--nologo'], apiDirectory);
  if (options.has('--check')) {
    console.log('Both builds passed. No servers started.');
    return;
  }
  // Check again after builds in case another application acquired either port.
  await checkPort(5000, '127.0.0.1');
  await checkPort(5173, host);
  const api = start('dotnet', ['run', '--no-build', '--no-launch-profile', '--project', project, '--urls', 'http://127.0.0.1:5000'], apiDirectory);
  await waitForService('http://127.0.0.1:5000/api/transfer', api);
  if (stopping) throw new Error('Startup interrupted.');
  const ui = start(process.execPath, [vite, '--host', host, '--port', '5173', '--strictPort']);
  // Stop the sibling even if it exits while the other service is still starting.
  const exited = Promise.race([api.done, ui.done]).then((code) => {
    if (!stopping) {
      console.error(`A service exited (code ${code}); stopping both services.`);
      return stop(code || 1);
    }
  });
  await waitForService('http://127.0.0.1:5173/', ui);
  if (stopping) return;
  console.log('\nLiquidVault is ready: http://localhost:5173');
  console.log('API: http://localhost:5000/api/transfer');
  if (host === '0.0.0.0') {
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.family === 'IPv4' && !address.internal) console.log(`LAN: http://${address.address}:5173`);
      }
    }
    console.log('LAN mode: all reachable clients share the current unauthenticated transfer board.');
  }
  console.log('Press Ctrl+C to stop both services.');
  await exited;
}

try { await main(); }
catch (error) {
  if (!stopping) console.error(`\n${error.message}`);
  await stop(stopping ? process.exitCode : 1);
}
