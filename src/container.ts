import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { x } from 'tinyexec';
import upath from 'upath';
import type { ResolvedTaskConfig } from './config/resolve.js';
import { CONTAINER_ROOT_DIR } from './constants.js';
import { Logger } from './logger.js';
import { importNodeModule } from './node-modules.js';
import { exec, isValidUri, pathEquals } from './util.js';

export function toContainerPath(urlOrAbsPath: string): string {
  if (isValidUri(urlOrAbsPath)) {
    if (urlOrAbsPath.toLowerCase().startsWith('file')) {
      return pathToFileURL(
        upath.posix.join(
          CONTAINER_ROOT_DIR,
          upath.toUnix(fileURLToPath(urlOrAbsPath)).replace(/^\w:/, ''),
        ),
      ).href;
    } else {
      return urlOrAbsPath;
    }
  }
  return upath.posix.join(
    CONTAINER_ROOT_DIR,
    upath.toUnix(urlOrAbsPath).replace(/^\w:/, ''),
  );
}

export function collectVolumeArgs(mountPoints: string[]): string[] {
  return mountPoints
    .filter((p, i, array) => {
      if (i !== array.indexOf(p)) {
        // duplicated path
        return false;
      }
      let parent = p;
      while (!pathEquals(parent, upath.dirname(parent))) {
        parent = upath.dirname(parent);
        if (array.includes(parent)) {
          // other mount point contains its directory
          return false;
        }
      }
      return true;
    })
    .map((p) => `${p}:${toContainerPath(p)}`);
}

export async function runContainer({
  image,
  userVolumeArgs,
  commandArgs,
  entrypoint,
  env,
  workdir,
}: {
  image: string;
  userVolumeArgs: string[];
  commandArgs: string[];
  entrypoint?: string;
  env?: [string, string][];
  workdir?: string;
}) {
  const { default: commandExists } = await importNodeModule('command-exists');
  if (!(await commandExists('docker'))) {
    throw new Error(
      `Docker isn't be installed. To use this feature, you'll need to install Docker.`,
    );
  }
  const version = (
    await exec('docker', ['version', '--format', '{{.Server.Version}}'])
  ).stdout;
  const [major, minor] = version.split('.').map(Number);
  if (major < 20 || (major === 20 && minor < 10)) {
    throw new Error(
      `Docker version ${version} is not supported. Please upgrade to Docker 20.10.0 or later.`,
    );
  }

  try {
    using _ = Logger.suspendLogging('Launching docker container');
    const args = [
      'run',
      ...(Logger.isInteractive ? ['-it'] : []),
      '--rm',
      ...(entrypoint ? ['--entrypoint', entrypoint] : []),
      ...(env ? env.flatMap(([k, v]) => ['-e', `${k}=${v}`]) : []),
      ...(process.env.DEBUG
        ? ['-e', `DEBUG=${process.env.DEBUG}`] // escape seems to work well
        : []),
      ...userVolumeArgs.flatMap((arg) => ['-v', arg]),
      ...(workdir ? ['-w', workdir] : []),
      image,
      ...commandArgs,
    ];
    Logger.debug(`docker ${args.join(' ')}`);
    const proc = x('docker', args, {
      throwOnError: true,
      nodeOptions: {
        stdio: Logger.isInteractive ? 'inherit' : undefined,
      },
    });
    if (Logger.isInteractive) {
      await proc;
    } else {
      for await (const line of proc) {
        Logger.log(line);
      }
    }
  } catch (error) {
    throw new Error(
      'An error occurred on the running container. Please see logs above.',
    );
  }
}

export async function launchContainerBrowser({
  image,
  browserType,
  tag,
  port,
  args,
}: {
  image: string;
  browserType: string;
  tag: string;
  port: number;
  args: string[];
}): Promise<{ wsEndpoint: string; stop: () => Promise<void> }> {
  const dockerArgs = [
    'run',
    '--rm',
    '--entrypoint',
    'serve-browser',
    '-p',
    `${port}:${port}`,
    image,
    '--browser',
    browserType,
    '--tag',
    tag,
    '--port',
    String(port),
    '--bind-address',
    '0.0.0.0',
    '--',
    ...args,
  ];
  Logger.debug(`docker ${dockerArgs.join(' ')}`);

  const proc = x('docker', dockerArgs, {
    nodeOptions: {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  });

  const child = proc.process;
  if (!child?.stdout) {
    throw new Error('Failed to start docker container');
  }

  // Forward stderr for download progress
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  // Read wsEndpoint from stdout
  const wsEndpoint = await new Promise<string>((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('ws://')) {
          child!.stdout!.off('data', onData);
          resolve(trimmed);
          return;
        }
      }
    };
    child!.stdout!.on('data', onData);
    child!.on('error', reject);
    child!.on('exit', (code) => {
      reject(
        new Error(
          `Docker container exited with code ${code} before providing wsEndpoint`,
        ),
      );
    });
  });

  Logger.debug(`Container browser wsEndpoint: ${wsEndpoint}`);

  return {
    wsEndpoint,
    async stop() {
      if (child?.exitCode !== null) {
        return;
      }
      child?.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        child?.on('exit', () => resolve());
        setTimeout(() => {
          child?.kill('SIGKILL');
          resolve();
        }, 5000);
      });
    },
  };
}
