import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import upath from 'upath';
import { getExecutableBrowserPath } from './browser.js';
import type { PdfOutput, ResolvedTaskConfig } from './config/resolve.js';
import { Logger } from './logger.js';
import { buildPDF } from './output/pdf.js';

const QEMU_PROXY_PORT = 9223;
const QEMU_BASE_IMAGE = upath.join(
  upath.dirname(new URL(import.meta.url).pathname),
  '../poc/debian-13-nocloud-amd64.qcow2',
);
const SERVE_BROWSER_SCRIPT = upath.join(
  upath.dirname(new URL(import.meta.url).pathname),
  '../poc/serve-browser.sh',
);

async function waitForCDP(port: number, timeoutMs = 120000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timeout waiting for CDP on port ${port}`);
}

export async function launchQemuBrowser({
  config,
}: {
  config: ResolvedTaskConfig;
}): Promise<{
  browserURL: string;
  cleanup: () => void;
}> {
  const qemuPkg =
    process.platform === 'win32'
      ? '@vivliostyle/qemu-win32-x64'
      : '@vivliostyle/qemu-linux-x64';
  const { qemuSystem, qemuImg } = (await import(qemuPkg)) as {
    qemuSystem: string;
    qemuImg: string;
  };

  if (!existsSync(QEMU_BASE_IMAGE)) {
    throw new Error(
      `QEMU base image not found: ${QEMU_BASE_IMAGE}\nPlease place the debian-13-nocloud-amd64.qcow2 in the poc/ directory.`,
    );
  }

  // Resolve browser executable path
  const browserPath = await getExecutableBrowserPath(config.browser);
  const browserDir = upath.dirname(browserPath);

  // Prepare a single shared directory containing browser + config
  // VVFAT exposes this as a FAT partition accessible from the VM
  const timestamp = Date.now();
  const overlay = upath.join(tmpdir(), `vivliostyle-qemu-${timestamp}.qcow2`);
  const shareDir = upath.join(tmpdir(), `vivliostyle-qemu-share-${timestamp}`);

  execFileSync(qemuImg, [
    'create',
    '-f',
    'qcow2',
    '-b',
    QEMU_BASE_IMAGE,
    '-F',
    'qcow2',
    overlay,
  ]);

  mkdirSync(shareDir, { recursive: true });
  cpSync(browserDir, upath.join(shareDir, 'browser'), { recursive: true });
  writeFileSync(
    upath.join(shareDir, 'browser-path'),
    '/mnt/share/browser/' + upath.basename(browserPath),
  );
  cpSync(SERVE_BROWSER_SCRIPT, upath.join(shareDir, 'serve-browser.sh'));
  execFileSync('chmod', ['+x', upath.join(shareDir, 'serve-browser.sh')]);

  // Capture stderr for diagnostics
  let qemuStderr = '';
  const qemu: ChildProcess = spawn(
    qemuSystem,
    [
      ...(existsSync('/dev/kvm') ? ['-enable-kvm'] : []),
      '-drive',
      `file=${overlay},if=virtio`,
      '-drive',
      `file=fat:${shareDir},if=virtio,read-only=on`,
      '-m',
      '2G',
      '-smp',
      '2',
      '-netdev',
      `user,id=net0,hostfwd=tcp::${QEMU_PROXY_PORT}-:${QEMU_PROXY_PORT}`,
      '-device',
      'virtio-net-pci,netdev=net0',
      '-nographic',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  qemu.stdout?.on('data', (d: Buffer) => {
    Logger.debug('[qemu:stdout]', d.toString());
  });
  qemu.stderr?.on('data', (d: Buffer) => {
    qemuStderr += d.toString();
    Logger.debug('[qemu:stderr]', d.toString());
  });

  const cleanup = () => {
    qemu.kill();
    try {
      unlinkSync(overlay);
    } catch {}
    try {
      rmSync(shareDir, { recursive: true, force: true });
    } catch {}
  };

  const earlyExit = new Promise<never>((_, reject) => {
    qemu.on('exit', (code) => {
      reject(
        new Error(`QEMU exited unexpectedly with code ${code}\n${qemuStderr}`),
      );
    });
  });

  try {
    await Promise.race([
      waitForCDP(QEMU_PROXY_PORT, config.timeout),
      earlyExit,
    ]);
  } catch (err) {
    cleanup();
    throw err;
  }

  return {
    browserURL: `http://127.0.0.1:${QEMU_PROXY_PORT}`,
    cleanup,
  };
}

export async function buildPDFWithQemu({
  target,
  config,
}: {
  target: PdfOutput;
  config: ResolvedTaskConfig;
}): Promise<string | null> {
  using _ = Logger.suspendLogging('Launching QEMU VM for PDF rendering');

  const { browserURL, cleanup } = await launchQemuBrowser({ config });

  try {
    const puppeteer = await import('puppeteer-core');
    const browser = await puppeteer.connect({ browserURL });

    const qemuConfig: ResolvedTaskConfig = {
      ...config,
      browser: {
        ...config.browser,
        executablePath: undefined,
      },
    };

    const result = await buildPDF({ target, config: qemuConfig });

    await browser.disconnect();
    return result;
  } finally {
    cleanup();
  }
}
