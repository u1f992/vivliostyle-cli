import chalk from 'chalk';
import { lookup as mime } from 'mime-types';
import fs from 'node:fs';
import { TOC_TITLE } from '../const.js';
import {
  ContentsEntry,
  CoverEntry,
  ManuscriptEntry,
  MergedConfig,
  ParsedTheme,
  WebPublicationManifestConfig,
} from '../input/config.js';
import type {
  PublicationLinks,
  PublicationManifest,
  URL as PublicationURL,
} from '../schema/publication.schema.js';
import type { ArticleEntryObject } from '../schema/vivliostyleConfig.schema.js';
import {
  DetailError,
  assertPubManifestSchema,
  copy,
  debug,
  log,
  pathContains,
  pathEquals,
  remove,
  safeGlob,
  startLogging,
  upath,
  useTmpDirectory,
} from '../util.js';
import {
  generateCoverHtml,
  generateTocHtml,
  isCovertHtml,
  isTocHtml,
  processManuscriptHtml,
} from './html.js';
import { processMarkdown } from './markdown.js';
import {
  checkThemeInstallationNecessity,
  installThemeDependencies,
} from './theme.js';

function locateThemePath(theme: ParsedTheme, from: string): string | string[] {
  if (theme.type === 'uri') {
    return theme.location;
  }
  if (theme.type === 'file') {
    return upath.relative(from, theme.location);
  }
  if (theme.importPath) {
    return [theme.importPath].flat().map((locator) => {
      const resolvedPath = upath.resolve(theme.location, locator);
      if (
        !pathContains(theme.location, resolvedPath) ||
        !fs.existsSync(resolvedPath)
      ) {
        throw new Error(
          `Could not find a style path ${theme.importPath} for the theme: ${theme.name}.`,
        );
      }
      return upath.relative(from, resolvedPath);
    });
  } else {
    const pkgJsonPath = upath.join(theme.location, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    const maybeStyle =
      packageJson?.vivliostyle?.theme?.style ??
      packageJson.style ??
      packageJson.main;
    if (!maybeStyle) {
      throw new DetailError(
        `Could not find a style file for the theme: ${theme.name}.`,
        'Please ensure this package satisfies a `vivliostyle.theme.style` propertiy.',
      );
    }
    return upath.relative(from, upath.join(theme.location, maybeStyle));
  }
}

export async function cleanupWorkspace({
  entryContextDir,
  workspaceDir,
  themesDir,
}: MergedConfig) {
  if (
    pathEquals(workspaceDir, entryContextDir) ||
    pathContains(workspaceDir, entryContextDir)
  ) {
    return;
  }
  // workspaceDir is placed on different directory; delete everything excepting theme files
  debug('cleanup workspace files', workspaceDir);
  let movedThemePath: string | undefined;
  if (pathContains(workspaceDir, themesDir) && fs.existsSync(themesDir)) {
    [movedThemePath] = await useTmpDirectory();
    await copy(themesDir, movedThemePath);
  }
  await remove(workspaceDir);
  if (movedThemePath) {
    fs.mkdirSync(upath.dirname(themesDir), { recursive: true });
    await copy(movedThemePath, themesDir);
  }
}

export async function prepareThemeDirectory({
  themesDir,
  themeIndexes,
}: MergedConfig) {
  // install theme packages
  if (await checkThemeInstallationNecessity({ themesDir, themeIndexes })) {
    startLogging('Installing theme files');
    await installThemeDependencies({ themesDir, themeIndexes });
  }

  // copy theme files
  for (const theme of themeIndexes) {
    if (theme.type === 'file' && !pathEquals(theme.source, theme.location)) {
      fs.mkdirSync(upath.dirname(theme.location), { recursive: true });
      await copy(theme.source, theme.location);
    }
  }
}

// https://www.w3.org/TR/pub-manifest/
export function generateManifest(
  outputPath: string,
  entryContextDir: string,
  options: {
    title?: string;
    author?: string;
    language?: string;
    readingProgression?: 'ltr' | 'rtl';
    modified: string;
    entries: ArticleEntryObject[];
    cover?: {
      url: string;
      name: string;
    };
    links?: (PublicationURL | PublicationLinks)[];
    resources?: (PublicationURL | PublicationLinks)[];
  },
): PublicationManifest {
  const entries: PublicationLinks[] = options.entries.map((entry) => ({
    url: encodeURI(entry.path),
    ...(entry.title && { name: entry.title }),
    ...(entry.encodingFormat && { encodingFormat: entry.encodingFormat }),
    ...(entry.rel && { rel: entry.rel }),
    ...((entry.rel === 'contents' || entry.rel === 'cover') && {
      type: 'LinkedResource',
    }),
  }));
  const links: (PublicationURL | PublicationLinks)[] = [
    options.links || [],
  ].flat();
  const resources: (PublicationURL | PublicationLinks)[] = [
    options.resources || [],
  ].flat();

  if (options.cover) {
    const mimeType = mime(options.cover.url);
    if (mimeType) {
      resources.push({
        rel: 'cover',
        url: encodeURI(options.cover.url),
        name: options.cover.name,
        encodingFormat: mimeType,
      });
    } else {
      log(
        `\n${chalk.yellow('Cover image ')}${chalk.bold.yellow(
          `"${options.cover}"`,
        )}${chalk.yellow(
          ' was set in your configuration but couldn’t detect the image metadata. Please check a valid cover file is placed.',
        )}`,
      );
    }
  }

  const publication: PublicationManifest = {
    '@context': ['https://schema.org', 'https://www.w3.org/ns/pub-context'],
    type: 'Book',
    conformsTo: 'https://github.com/vivliostyle/vivliostyle-cli',
    ...(options.title && { name: options.title }),
    ...(options.author && { author: options.author }),
    ...(options.language && { inLanguage: options.language }),
    ...(options.readingProgression && {
      readingProgression: options.readingProgression,
    }),
    dateModified: options.modified,
    readingOrder: entries,
    resources,
    links,
  };

  const publicationJson = JSON.stringify(publication, null, 2);
  try {
    assertPubManifestSchema(publication, {
      json: publicationJson,
    });
  } catch (error) {
    const thrownError = error as Error | string;
    throw new DetailError(
      `Validation of pubManifest failed. Please check the schema: ${outputPath}`,
      typeof thrownError === 'string'
        ? thrownError
        : thrownError.stack ?? thrownError.message,
    );
  }
  fs.writeFileSync(outputPath, publicationJson);
  return publication;
}

export async function compile({
  entryContextDir,
  workspaceDir,
  manifestPath,
  needToGenerateManifest,
  title,
  author,
  entries,
  language,
  readingProgression,
  cover,
  vfmOptions,
}: MergedConfig & WebPublicationManifestConfig): Promise<void> {
  const generativeContentsEntry = entries.find(
    (e): e is ContentsEntry => !('source' in e) && e.rel === 'contents',
  );
  if (
    generativeContentsEntry &&
    fs.existsSync(generativeContentsEntry.target) &&
    !isTocHtml(generativeContentsEntry.target)
  ) {
    throw new Error(
      `${generativeContentsEntry.target} is set as a destination to create a ToC HTML file, but there is already a document other than the ToC file in this location. Please move this file, or set a 'toc' option in vivliostyle.config.js to specify another destination for the ToC file.`,
    );
  }

  const generativeCoverPageEntries = entries.filter(
    (e): e is CoverEntry => !('source' in e) && e.rel === 'cover',
  );
  generativeCoverPageEntries.forEach(({ target }) => {
    if (fs.existsSync(target) && !isCovertHtml(target)) {
      throw new Error(
        `${target} is set as a destination to create a cover page HTML file, but there is already a document other than the cover page file in this location.`,
      );
    }
  });

  const contentEntries = entries.filter(
    (e): e is ManuscriptEntry => 'source' in e,
  );
  for (const entry of contentEntries) {
    fs.mkdirSync(upath.dirname(entry.target), { recursive: true });

    // calculate style path
    const style = entry.themes.flatMap((theme) =>
      locateThemePath(theme, upath.dirname(entry.target)),
    );
    if (entry.type === 'text/markdown') {
      // compile markdown
      const vfile = processMarkdown(entry.source, {
        ...vfmOptions,
        style,
        title: entry.title,
        language: language ?? undefined,
      });
      const compiledEntry = String(vfile);
      fs.writeFileSync(entry.target, compiledEntry);
    } else if (
      entry.type === 'text/html' ||
      entry.type === 'application/xhtml+xml'
    ) {
      if (!pathEquals(entry.source, entry.target)) {
        const html = processManuscriptHtml(entry.source, {
          style,
          title: entry.title,
          contentType: entry.type,
          language,
        });
        fs.writeFileSync(entry.target, html);
      }
    } else {
      if (!pathEquals(entry.source, entry.target)) {
        await copy(entry.source, entry.target);
      }
    }
  }

  // generate toc
  if (generativeContentsEntry) {
    const entry = generativeContentsEntry;
    const stylesheets = entry.themes.flatMap((theme) =>
      locateThemePath(theme, upath.dirname(entry.target)),
    );
    const tocString = generateTocHtml({
      entries: contentEntries,
      manifestPath,
      distDir: upath.dirname(entry.target),
      language,
      title,
      tocTitle: entry.title ?? TOC_TITLE,
      stylesheets,
      styleOptions: entry,
    });
    fs.mkdirSync(upath.dirname(entry.target), { recursive: true });
    fs.writeFileSync(entry.target, tocString);
  }

  // generate cover
  for (const entry of generativeCoverPageEntries) {
    const stylesheets = entry.themes.flatMap((theme) =>
      locateThemePath(theme, upath.dirname(entry.target)),
    );
    const coverHtml = generateCoverHtml({
      imageSrc: upath.relative(
        upath.join(
          entryContextDir,
          upath.relative(workspaceDir, entry.target),
          '..',
        ),
        entry.coverImageSrc,
      ),
      imageAlt: entry.coverImageAlt,
      language,
      title: entry.title,
      stylesheets,
      styleOptions: entry,
    });
    fs.mkdirSync(upath.dirname(entry.target), { recursive: true });
    fs.writeFileSync(entry.target, coverHtml, 'utf8');
  }

  // generate manifest
  if (needToGenerateManifest) {
    const manifestEntries: ArticleEntryObject[] = entries.map((entry) => ({
      title: entry.title,
      path: upath.relative(workspaceDir, entry.target),
      encodingFormat:
        !('type' in entry) ||
        entry.type === 'text/markdown' ||
        entry.type === 'text/html'
          ? undefined
          : entry.type,
      rel: entry.rel,
    }));
    generateManifest(manifestPath, entryContextDir, {
      title,
      author,
      language,
      readingProgression,
      cover: cover && {
        url: upath.relative(entryContextDir, cover.src),
        name: cover.name,
      },
      entries: manifestEntries,
      modified: new Date().toISOString(),
    });
  }
}

export async function copyAssets({
  entryContextDir,
  workspaceDir,
  includeAssets,
  outputs,
}: MergedConfig): Promise<void> {
  if (pathEquals(entryContextDir, workspaceDir)) {
    return;
  }
  const relWorkspaceDir = upath.relative(entryContextDir, workspaceDir);
  const assets = await safeGlob(includeAssets, {
    cwd: entryContextDir,
    ignore: [
      // don't copy auto-generated assets
      ...outputs.flatMap(({ format, path: p }) =>
        !pathContains(entryContextDir, p)
          ? []
          : format === 'webpub'
          ? upath.join(upath.relative(entryContextDir, p), '**')
          : upath.relative(entryContextDir, p),
      ),
      // don't copy workspace itself
      ...(relWorkspaceDir ? [upath.join(relWorkspaceDir, '**')] : []),
    ],
    followSymbolicLinks: true,
    gitignore: false,
  });
  debug('assets', assets);
  for (const asset of assets) {
    const target = upath.join(workspaceDir, asset);
    fs.mkdirSync(upath.dirname(target), { recursive: true });
    await copy(upath.resolve(entryContextDir, asset), target);
  }
}

export function checkOverwriteViolation(
  { entryContextDir, workspaceDir }: MergedConfig,
  target: string,
  fileInformation: string,
) {
  if (
    pathContains(target, entryContextDir) ||
    pathEquals(target, entryContextDir)
  ) {
    throw new Error(
      `${target} is set as output destination of ${fileInformation}, however, this output path will overwrite the manuscript file(s). Please specify other paths.`,
    );
  }
  if (pathContains(target, workspaceDir) || pathEquals(target, workspaceDir)) {
    throw new Error(
      `${target} is set as output destination of ${fileInformation}, however, this output path will overwrite the working directory of Vivliostyle. Please specify other paths.`,
    );
  }
}
