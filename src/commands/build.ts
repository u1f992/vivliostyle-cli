import process from 'node:process';
import { build } from '../core/build.js';
import { gracefulError } from '../util.js';
import { parseBuildCommand } from './build.parser.js';

try {
  const inlineConfig = parseBuildCommand(process.argv);
  await build(inlineConfig);
} catch (err) {
  if (err instanceof Error) {
    gracefulError(err);
  }
}
