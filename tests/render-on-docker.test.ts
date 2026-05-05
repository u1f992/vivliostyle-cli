import { execFileSync } from 'node:child_process';
import { fileTypeFromFile } from 'file-type';
import { describe, expect, it } from 'vitest';
import { resolveFixture, runCommand } from './command-util.js';

const probe = (cmd: string, args: string[]): boolean => {
  try {
    execFileSync(cmd, args, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

const dockerAvailable = probe('docker', ['version']);

// Only one image is consulted: VIVLIOSTYLE_TEST_IMAGE if set, otherwise the
// latest published image. The image must already exist locally — we do not
// pull on demand, so CI without a pre-pulled image skips this suite.
const candidateImage =
  process.env.VIVLIOSTYLE_TEST_IMAGE || 'ghcr.io/vivliostyle/cli:latest';

const image =
  dockerAvailable && probe('docker', ['image', 'inspect', candidateImage])
    ? candidateImage
    : undefined;

describe.skipIf(!image)(
  'render-mode docker (mirrors examples/render-on-docker/)',
  () => {
    it('produces a valid PDF for a markdown manuscript via docker render', async () => {
      await runCommand(
        [
          'build',
          '--render-mode',
          'docker',
          '--image',
          image!,
          '-o',
          '.vs-pdf/out.pdf',
          'manuscript.md',
        ],
        { cwd: resolveFixture('render-on-docker'), port: 23100 },
      );

      const type = await fileTypeFromFile(
        resolveFixture('render-on-docker/.vs-pdf/out.pdf'),
      );
      expect(type?.mime).toEqual('application/pdf');
    }, 240000);
  },
);
