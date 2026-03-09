import type * as hast from 'hast';
import archiver from 'archiver';
import { lookup as lookupLanguage } from 'bcp-47-match';
import { XMLBuilder } from 'fast-xml-parser';
import { copy } from 'fs-extra/esm';
import GithubSlugger from 'github-slugger';
import { toHtml } from 'hast-util-to-html';
import { lookup as mime } from 'mime-types';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import rehype from 'rehype';
import { EXIT, visit } from 'unist-util-visit';
import upath from 'upath';
import { v4 as uuid } from 'uuid';
import {
  EPUB_CONTAINER_XML,
  EPUB_LANDMARKS_COVER_ENTRY,
  EPUB_LANDMARKS_TITLE,
  EPUB_LANDMARKS_TOC_ENTRY,
  EPUB_NS,
  TOC_TITLE,
  XML_DECLARATION,
} from '../const.js';
import { Logger } from '../logger.js';
import {
  type PageListResourceTreeRoot,
  type TocResourceTreeRoot,
  parsePageListDocument,
  parseTocDocument,
} from '../processor/html.js';
import type {
  Contributor,
  LocalizableStringObject,
  LocalizableStringOrObject,
  PublicationLinks,
  PublicationManifest,
  ResourceCategorization,
} from '../schema/publication.schema.js';
import { DetailError, useTmpDirectory } from '../util.js';

interface ManifestEntry {
  href: string;
  mediaType: string;
  properties?: string;
}

interface LandmarkEntry {
  type: string;
  href: string;
  text: string;
}

interface SpineEntry {
  href: string;
}

const TOC_ID = 'toc';
const LANDMARKS_ID = 'landmarks';
const PAGELIST_ID = 'page-list';
const COVER_IMAGE_MIMETYPES = [
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
];

const changeExtname = (filepath: string, newExt: string) => {
  let ext = upath.extname(filepath);
  return `${filepath.slice(0, -ext.length)}${newExt}`;
};

const getRelativeHref = (target: string, baseUrl: string, rootUrl: string) => {
  const absBasePath = upath.join('/', baseUrl);
  const absRootPath = upath.join('/', rootUrl);
  const hrefUrl = new URL(encodeURI(target), pathToFileURL(absBasePath));
  if (hrefUrl.protocol !== 'file:') {
    return target;
  }
  if (/\.html?$/.test(hrefUrl.pathname)) {
    hrefUrl.pathname = changeExtname(hrefUrl.pathname, '.xhtml');
  }
  const pathname = upath.posix.relative(
    pathToFileURL(upath.dirname(absRootPath)).pathname,
    hrefUrl.pathname,
  );
  return `${pathname}${hrefUrl.search}${hrefUrl.hash}`;
};

const normalizeLocalizableString = (
  value: LocalizableStringOrObject | undefined,
  availableLanguages: string[],
): string | undefined => {
  if (!value) {
    return;
  }
  const values = [value]
    .flat()
    .map((value) => (typeof value === 'string' ? { value } : value));
  const localizedValues = values.filter(
    (v): v is LocalizableStringObject & { language: string } => !!v.language,
  );
  const preferredLang = lookupLanguage(
    localizedValues.map((v) => v.language),
    availableLanguages,
  );
  if (preferredLang) {
    return localizedValues[
      localizedValues.findIndex((v) => v.language === preferredLang)
    ].value;
  }
  return values.find((v) => !v.language)?.value;
};

const appendManifestProperty = (entry: ManifestEntry, newProperty: string) => {
  entry.properties = entry.properties
    ? Array.from(new Set([...entry.properties.split(' '), newProperty])).join(
        ' ',
      )
    : newProperty;
};

/** Parse an HTML string into a hast tree using rehype. */
function parseHtmlToHast(html: string): hast.Root {
  return rehype()
    .data('settings', { allowDangerousHtml: true })
    .parse(html) as unknown as hast.Root;
}

/** Serialize a hast tree to XHTML string with XML declaration. */
function hastToXhtml(tree: hast.Root): string {
  const html = toHtml(tree, {
    space: 'svg',
    closeEmptyElements: true,
    allowDangerousHtml: true,
    upperDoctype: true,
  });
  return `${XML_DECLARATION}\n${html}`;
}

/** Find the first element matching a predicate via tree traversal. */
function findElement(
  tree: hast.Root | hast.Element,
  predicate: (node: hast.Element) => boolean,
): hast.Element | undefined {
  let found: hast.Element | undefined;
  visit(tree, 'element', (node) => {
    if (predicate(node)) {
      found = node;
      return EXIT;
    }
  });
  return found;
}

/** Find all elements matching a predicate via tree traversal. */
function findAllElements(
  tree: hast.Root | hast.Element,
  predicate: (node: hast.Element) => boolean,
): hast.Element[] {
  const results: hast.Element[] = [];
  visit(tree, 'element', (node) => {
    if (predicate(node)) {
      results.push(node);
    }
  });
  return results;
}

/** Get the text content of a hast element (recursive). */
function getTextContent(node: hast.Element | hast.Root): string {
  let text = '';
  for (const child of node.children) {
    if (child.type === 'text') {
      text += child.value;
    } else if (child.type === 'element') {
      text += getTextContent(child);
    }
  }
  return text;
}

/** Create a hast element node. */
function h(
  tagName: string,
  properties: hast.Properties,
  children: hast.ElementContent[] = [],
): hast.Element {
  return { type: 'element', tagName, properties, children };
}

/** Create a hast text node. */
function text(value: string): hast.Text {
  return { type: 'text', value };
}

export async function exportEpub({
  webpubDir,
  entryHtmlFile,
  manifest,
  relManifestPath,
  target,
  epubVersion,
}: {
  webpubDir: string;
  entryHtmlFile?: string;
  manifest: PublicationManifest;
  relManifestPath?: string;
  target: string;
  epubVersion: '3.0';
}) {
  Logger.debug('Export EPUB', {
    webpubDir,
    entryHtmlFile,
    relManifestPath,
    target,
    epubVersion,
  });

  const [tmpDir] = await useTmpDirectory();
  fs.mkdirSync(upath.join(tmpDir, 'META-INF'), { recursive: true });
  await copy(webpubDir, upath.join(tmpDir, 'EPUB'));

  const uid = `urn:uuid:${uuid()}`;
  const entryHtmlRelPath =
    entryHtmlFile &&
    upath.relative(webpubDir, upath.resolve(webpubDir, entryHtmlFile));

  const findPublicationLink = (
    relType: string,
    list?: ResourceCategorization,
    filter?: (e: PublicationLinks) => boolean,
  ) =>
    [list]
      .flat()
      .find(
        (e): e is PublicationLinks =>
          typeof e === 'object' && e.rel === relType && (!filter || filter(e)),
      );
  const tocResource = findPublicationLink('contents', [
    ...[manifest.readingOrder || []].flat(),
    ...[manifest.resources || []].flat(),
  ]);
  const pageListResource = findPublicationLink('pagelist', [
    ...[manifest.readingOrder || []].flat(),
    ...[manifest.resources || []].flat(),
  ]);
  // NOTE: EPUB allows one cover-image item unlike web publication
  // vivliostyle-cli takes the first cover resource.
  const pictureCoverResource = findPublicationLink(
    'cover',
    manifest.resources,
    (e) =>
      COVER_IMAGE_MIMETYPES.includes(e.encodingFormat || mime(e.url) || ''),
  );
  const htmlCoverResource = findPublicationLink(
    'cover',
    [
      ...[manifest.readingOrder || []].flat(),
      ...[manifest.resources || []].flat(),
    ],
    (e) => /\.html?$/.test(e.url),
  );

  const manifestItem = [
    ...[manifest.links || []].flat(),
    ...[manifest.readingOrder || []].flat(),
    ...[manifest.resources || []].flat(),
  ].reduce(
    (acc, val) => {
      const { url, encodingFormat } =
        typeof val === 'string' ? ({ url: val } as PublicationLinks) : val;
      // Only accepts path-like url
      try {
        new URL(url);
        return acc;
      } catch (e) {
        /* NOOP */
      }
      if (!fs.existsSync(upath.join(tmpDir, 'EPUB', url))) {
        return acc;
      }
      const mediaType = encodingFormat || mime(url) || 'text/plain';
      acc[url] = {
        href: url,
        mediaType,
      };
      if (/\.html?$/.test(url)) {
        acc[url].href = changeExtname(url, '.xhtml');
        acc[url].mediaType = 'application/xhtml+xml';
      }
      if (url === pictureCoverResource?.url) {
        acc[url].properties = 'cover-image';
      }
      return acc;
    },
    {} as Record<string, ManifestEntry>,
  );

  const htmlFiles = Object.keys(manifestItem).filter((url) =>
    /\.html?$/.test(url),
  );
  let tocHtml = htmlFiles.find((f) => f === tocResource?.url);
  const readingOrder = [manifest.readingOrder || entryHtmlRelPath]
    .flat()
    .flatMap((v) => (v ? (typeof v === 'string' ? { url: v } : v) : []));
  if (!tocHtml) {
    Logger.logWarn(
      'No table of contents document was found. for EPUB output, we recommend to enable `toc` option in your Vivliostyle config file to generate a table of contents document.',
    );
    tocHtml =
      htmlFiles.find((f) => f === entryHtmlRelPath) || readingOrder[0].url;
  }
  const spineItems = readingOrder.map<SpineEntry>(({ url }) => ({
    href: changeExtname(url, '.xhtml'),
  }));
  if (!(tocHtml in manifestItem)) {
    manifestItem[tocHtml] = {
      href: changeExtname(tocHtml, '.xhtml'),
      mediaType: 'application/xhtml+xml',
    };
  }
  appendManifestProperty(manifestItem[tocHtml], 'nav');

  const landmarks: LandmarkEntry[] = [
    {
      type: 'toc',
      href: `${manifestItem[tocHtml].href}#${TOC_ID}`,
      text: EPUB_LANDMARKS_TOC_ENTRY,
    },
  ];
  if (htmlCoverResource) {
    landmarks.push({
      type: 'cover',
      href: changeExtname(htmlCoverResource.url, '.xhtml'),
      text: EPUB_LANDMARKS_COVER_ENTRY,
    });
  }

  const contextDir = upath.join(tmpDir, 'EPUB');
  type XhtmlEntry = Awaited<ReturnType<typeof transpileHtmlToXhtml>>;
  const processHtml = async (target: string) => {
    let parseResult: XhtmlEntry;
    try {
      parseResult = await transpileHtmlToXhtml({
        target,
        contextDir,
      });
    } catch (error) {
      const thrownError = error as Error;
      throw new DetailError(
        `Failed to transpile document to XHTML: ${target}`,
        thrownError.stack ?? thrownError.message,
      );
    }
    if (parseResult.hasMathmlContent) {
      appendManifestProperty(manifestItem[target], 'mathml');
    }
    if (parseResult.hasRemoteResources) {
      appendManifestProperty(manifestItem[target], 'remote-resources');
    }
    if (parseResult.hasScriptedContent) {
      appendManifestProperty(manifestItem[target], 'scripted');
    }
    if (parseResult.hasSvgContent) {
      appendManifestProperty(manifestItem[target], 'svg');
    }
    return parseResult;
  };

  const processResult: Record<string, XhtmlEntry> = {};
  Logger.debug(`Transpiling ToC HTML to XHTML: ${tocHtml}`);
  processResult[tocHtml] = await processHtml(tocHtml);
  for (const target of htmlFiles.filter((f) => f !== tocHtml)) {
    Logger.debug(`Transpiling HTML to XHTML: ${target}`);
    processResult[target] = await processHtml(target);
  }

  // Process ToC document
  const tocTree = processResult[tocHtml].tree;
  const docLanguages = [manifest.inLanguage]
    .flat()
    .filter((v): v is string => Boolean(v));
  if (docLanguages.length === 0) {
    const htmlEl = findElement(tocTree, (n) => n.tagName === 'html');
    const lang =
      (htmlEl?.properties?.lang as string) ||
      (htmlEl?.properties?.xmlLang as string) ||
      'en';
    docLanguages.push(lang);
  }
  const docTitle =
    normalizeLocalizableString(manifest.name, docLanguages) ||
    (() => {
      const titleEl = findElement(tocTree, (n) => n.tagName === 'title');
      return titleEl ? getTextContent(titleEl) : undefined;
    })();
  if (!docTitle) {
    throw new Error('EPUB must have a title of one or more characters');
  }
  const { tocResourceTree } = await processTocDocument({
    tree: processResult[tocHtml].tree,
    target: tocHtml,
    contextDir,
    readingOrder,
    docLanguages,
    landmarks,
  });

  // Process PageList document
  const pageListHtml = pageListResource?.url || entryHtmlRelPath;
  if (pageListHtml && pageListHtml in processResult) {
    await processPagelistDocument({
      tree: processResult[pageListHtml].tree,
      target: pageListHtml,
      contextDir,
    });
  }

  if (relManifestPath) {
    await fs.promises.rm(upath.join(tmpDir, 'EPUB', relManifestPath), {
      force: true,
      recursive: true,
    });
    delete manifestItem[relManifestPath];
  }

  // META-INF/container.xml
  fs.writeFileSync(
    upath.join(tmpDir, 'META-INF/container.xml'),
    EPUB_CONTAINER_XML,
    'utf8',
  );

  // EPUB/content.opf
  Logger.debug(`Generating content.opf`);
  fs.writeFileSync(
    upath.join(tmpDir, 'EPUB/content.opf'),
    buildEpubPackageDocument({
      epubVersion,
      uid,
      docTitle,
      docLanguages,
      manifest,
      spineItems,
      manifestItems: Object.values(manifestItem),
    }),
    'utf8',
  );

  await compressEpub({ target, sourceDir: tmpDir });
}

async function writeAsXhtml(tree: hast.Root, absPath: string) {
  const xhtml = hastToXhtml(tree);
  await fs.promises.writeFile(changeExtname(absPath, '.xhtml'), xhtml, 'utf8');
}

async function transpileHtmlToXhtml({
  target,
  contextDir,
}: {
  target: string;
  contextDir: string;
}): Promise<{
  tree: hast.Root;
  hasMathmlContent: boolean;
  hasRemoteResources: boolean;
  hasScriptedContent: boolean;
  hasSvgContent: boolean;
}> {
  const absPath = upath.join(contextDir, target);
  const html = fs.readFileSync(absPath, 'utf8');
  const tree = parseHtmlToHast(html);

  // Modify the <html> element: remove xmlns, add xmlns:epub
  const htmlEl = findElement(tree, (n) => n.tagName === 'html');
  if (htmlEl?.properties) {
    delete htmlEl.properties.xmlns;
    htmlEl.properties['xmlns:epub'] = EPUB_NS;
  }

  // Update all <a href="..."> elements
  const anchors = findAllElements(
    tree,
    (n) => n.tagName === 'a' && n.properties?.href != null,
  );
  for (const el of anchors) {
    const href = decodeURI(String(el.properties!.href));
    el.properties!.href = getRelativeHref(href, target, target);
  }

  await writeAsXhtml(tree, absPath);
  await fs.promises.unlink(absPath);

  // Feature detection
  let hasMathmlContent = false;
  let hasRemoteResources = false;
  let hasScriptedContent = false;
  let hasSvgContent = false;

  visit(tree, 'element', (node) => {
    const tag = node.tagName;
    if (tag === 'math') {
      hasMathmlContent = true;
    }
    if (tag === 'svg') {
      hasSvgContent = true;
    }
    if (tag === 'script' || tag === 'form') {
      hasScriptedContent = true;
    }
    const src = node.properties?.src as string | undefined;
    if (src && (src.startsWith('http://') || src.startsWith('https://'))) {
      hasRemoteResources = true;
    }
  });

  return {
    tree,
    hasMathmlContent,
    hasRemoteResources,
    hasScriptedContent,
    hasSvgContent,
  };
}

function replaceWithNavElement(el: hast.Element): hast.Element {
  el.tagName = 'nav';
  return el;
}

async function processTocDocument({
  tree,
  target,
  contextDir,
  readingOrder,
  docLanguages,
  landmarks,
}: {
  tree: hast.Root;
  target: string;
  contextDir: string;
  readingOrder: PublicationLinks[];
  docLanguages: string[];
  landmarks: LandmarkEntry[];
}): Promise<{ tocResourceTree: TocResourceTreeRoot | null }> {
  // Check for existing nav[epub:type] element
  // In hast, rehype may store `epub:type` as either `epubType` (camelCase) or
  // as a literal `epub:type` key depending on the parser. Check both.
  const existingNavEpub = findElement(
    tree,
    (n) =>
      n.tagName === 'nav' &&
      (n.properties?.['epubType'] != null ||
        n.properties?.['epub:type'] != null),
  );

  let tocResourceTree: TocResourceTreeRoot | null = null;
  if (!existingNavEpub) {
    tocResourceTree = parseTocDocument(tree);
    if (tocResourceTree) {
      const nav = replaceWithNavElement(tocResourceTree.element);
      nav.properties = nav.properties || {};
      nav.properties.id = TOC_ID;
      nav.properties['epub:type'] = 'toc';
    } else {
      Logger.debug(`Generating toc nav element: ${target}`);

      const olChildren: hast.ElementContent[] = [];
      tocResourceTree = {
        element: null!,
        children: [],
      };

      for (const content of readingOrder) {
        let name = normalizeLocalizableString(content.name, docLanguages);
        if (!name) {
          const xhtmlPath = upath.join(
            contextDir,
            changeExtname(content.url, '.xhtml'),
          );
          const xhtmlContent = fs.readFileSync(xhtmlPath, 'utf8');
          const xhtmlTree = parseHtmlToHast(xhtmlContent);
          const titleEl = findElement(xhtmlTree, (n) => n.tagName === 'title');
          name = titleEl ? getTextContent(titleEl) : '';
        }
        const a = h('a', { href: getRelativeHref(content.url, '', target) }, [
          text(name),
        ]);
        const li = h('li', {}, [a]);
        olChildren.push(li);
        tocResourceTree.children.push({
          element: li,
          label: a,
        });
      }

      const ol = h('ol', {}, olChildren);
      const nav = h(
        'nav',
        {
          id: TOC_ID,
          role: 'doc-toc',
          'epub:type': 'toc',
          hidden: '',
        },
        [h('h2', {}, [text(TOC_TITLE)]), ol],
      );
      tocResourceTree.element = nav;

      // Append nav to body
      const body = findElement(tree, (n) => n.tagName === 'body');
      if (body) {
        body.children.push(nav);
      }
      Logger.debug(
        'Generated toc nav element',
        toHtml(nav, { allowDangerousHtml: true }),
      );
    }

    if (landmarks.length > 0) {
      Logger.debug(`Generating landmark nav element: ${target}`);
      const olChildren: hast.ElementContent[] = [];
      for (const { type, href, text: entryText } of landmarks) {
        const a = h(
          'a',
          {
            'epub:type': type,
            href: getRelativeHref(href, '', target),
          },
          [text(entryText)],
        );
        const li = h('li', {}, [a]);
        olChildren.push(li);
      }
      const ol = h('ol', {}, olChildren);
      const nav = h(
        'nav',
        {
          'epub:type': 'landmarks',
          id: LANDMARKS_ID,
          hidden: '',
        },
        [h('h2', {}, [text(EPUB_LANDMARKS_TITLE)]), ol],
      );

      const body = findElement(tree, (n) => n.tagName === 'body');
      if (body) {
        body.children.push(nav);
      }
      Logger.debug(
        'Generated landmark nav element',
        toHtml(nav, { allowDangerousHtml: true }),
      );
    }
  }

  // Remove a publication manifest linked to ToC html.
  // When converting to EPUB, HTML files are converted to XHTML files
  // and no longer conform to Web publication, so we need to
  // explicitly remove the publication manifest.
  const publicationLinkEl = findElement(
    tree,
    (n) =>
      n.tagName === 'link' &&
      n.properties?.href != null &&
      [n.properties?.rel].flat().includes('publication'),
  );
  if (publicationLinkEl) {
    const href = String(publicationLinkEl.properties!.href).trim();
    if (href.startsWith('#')) {
      const scriptId = href.slice(1);
      // Find the script element by id and remove it
      visit(tree, 'element', (node, index, parent) => {
        if (
          node.properties?.id === scriptId &&
          node.properties?.type === 'application/ld+json'
        ) {
          if (parent && typeof index === 'number') {
            parent.children.splice(index, 1);
          }
          return EXIT;
        }
      });
    }
    // Remove the publication link element
    visit(tree, 'element', (node, index, parent) => {
      if (node === publicationLinkEl) {
        if (parent && typeof index === 'number') {
          parent.children.splice(index, 1);
        }
        return EXIT;
      }
    });
  }

  const absPath = upath.join(contextDir, target);
  await writeAsXhtml(tree, absPath);
  return { tocResourceTree };
}

async function processPagelistDocument({
  tree,
  target,
  contextDir,
}: {
  tree: hast.Root;
  target: string;
  contextDir: string;
}): Promise<{ pageListResourceTree: PageListResourceTreeRoot | null }> {
  const pageListResourceTree = parsePageListDocument(tree);
  if (pageListResourceTree) {
    const nav = replaceWithNavElement(pageListResourceTree.element);
    nav.properties = nav.properties || {};
    nav.properties.id = PAGELIST_ID;
    nav.properties['epub:type'] = 'page-list';
  }

  const absPath = upath.join(contextDir, target);
  await writeAsXhtml(tree, absPath);
  return { pageListResourceTree };
}

function buildEpubPackageDocument({
  epubVersion,
  manifest,
  uid,
  docTitle,
  docLanguages,
  spineItems,
  manifestItems,
}: Pick<Parameters<typeof exportEpub>[0], 'epubVersion'> & {
  manifest: PublicationManifest;
  uid: string;
  docTitle: string;
  docLanguages: string[];
  spineItems: SpineEntry[];
  manifestItems: ManifestEntry[];
}): string {
  const slugger = new GithubSlugger();
  slugger.reset();

  const bookIdentifier = slugger.slug('bookid');
  const normalizeDate = (value: string | number | undefined) =>
    value && `${new Date(value).toISOString().split('.')[0]}Z`;

  const transformToGenericTextNode = <T = {}>(value: unknown, attributes?: T) =>
    [value]
      .flat()
      .filter(Boolean)
      .map((v) => ({ ...(attributes || {}), '#text': `${value}` }));
  const transformContributor = (
    contributorMap: Record<string, Contributor | undefined>,
  ) =>
    Object.entries(contributorMap).flatMap(([type, contributor]) =>
      contributor
        ? [contributor].flat().map((entry, index) => ({
            _id: slugger.slug(`${type}-${index + 1}`),
            '#text':
              typeof entry === 'string'
                ? entry
                : normalizeLocalizableString(entry.name, docLanguages),
          }))
        : [],
    );

  const itemIdMap = new Map<string, string>();
  manifestItems.forEach(({ href }) => {
    itemIdMap.set(href, slugger.slug(href));
  });

  const builder = new XMLBuilder({
    format: true,
    ignoreAttributes: false,
    attributeNamePrefix: '_',
  });
  return builder.build({
    '?xml': {
      _version: '1.0',
      _encoding: 'UTF-8',
    },
    package: {
      _xmlns: 'http://www.idpf.org/2007/opf',
      _version: epubVersion,
      '_unique-identifier': bookIdentifier,
      '_xml:lang': docLanguages[0],
      metadata: {
        '_xmlns:dc': 'http://purl.org/dc/elements/1.1/',
        'dc:identifier': {
          _id: bookIdentifier,
          '#text': uid,
        },
        'dc:title': docTitle,
        'dc:language': docLanguages,
        'dc:creator': transformContributor({
          // TODO: Define proper order
          author: manifest.author,
          creator: manifest.creator,
          editor: manifest.editor,
          artist: manifest.artist,
          illustrator: manifest.illustrator,
          colorist: manifest.colorist,
          penciler: manifest.penciler,
          inker: manifest.inker,
          letterer: manifest.letterer,
          translator: manifest.translator,
          readBy: manifest.readBy,
        }),
        'dc:publisher': transformContributor({
          publisher: manifest.publisher,
        }),
        'dc:contributor': transformContributor({
          contributor: manifest.contributor,
        }),
        'dc:date': transformToGenericTextNode(
          normalizeDate(manifest.datePublished),
        ),
        'dc:rights': transformToGenericTextNode(
          manifest.copyrightHolder &&
            `© ${manifest.copyrightYear ? `${manifest.copyrightYear} ` : ''}${
              manifest.copyrightHolder
            }`,
        ),
        'dc:subject': transformToGenericTextNode(
          manifest['dc:subject'] || manifest.subject,
        ),
        meta: [
          ...transformToGenericTextNode(
            normalizeDate(manifest.dateModified || Date.now()),
            {
              _property: 'dcterms:modified',
            },
          ),
          ...(() => {
            const coverImage = manifestItems.find(
              (it) => it.properties === 'cover-image',
            );
            return coverImage
              ? [{ _name: 'cover', _content: itemIdMap.get(coverImage.href) }]
              : [];
          })(),
        ],
      },
      manifest: {
        item: manifestItems.map(({ href, mediaType, properties }) => ({
          _id: itemIdMap.get(href),
          _href: encodeURI(href),
          '_media-type': mediaType,
          ...(properties ? { _properties: properties } : {}),
        })),
      },
      spine: {
        ...(manifest.readingProgression
          ? { '_page-progression-direction': manifest.readingProgression }
          : {}),
        itemref: [
          ...spineItems.map(({ href }) => ({
            _idref: itemIdMap.get(href),
          })),
        ],
      },
    },
  });
}

async function compressEpub({
  target,
  sourceDir,
}: {
  target: string;
  sourceDir: string;
}): Promise<void> {
  Logger.debug(`Compressing EPUB: ${target}`);
  const output = fs.createWriteStream(target);
  const archive = archiver('zip', {
    zlib: { level: 9 }, // Compression level
  });
  return new Promise((resolve, reject) => {
    output.on('close', () => {
      Logger.debug(`Compressed EPUB: ${target}`);
      resolve();
    });
    output.on('error', reject);
    archive.on('warning', reject);
    archive.on('error', reject);
    archive.pipe(output);

    archive.append('application/epub+zip', {
      name: 'mimetype',
      // mimetype should not be compressed
      // https://www.w3.org/TR/epub-33/#sec-zip-container-mime
      store: true,
    });
    archive.directory(upath.join(sourceDir, 'META-INF'), 'META-INF');
    archive.directory(upath.join(sourceDir, 'EPUB'), 'EPUB');
    archive.finalize();
  });
}
