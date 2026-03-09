import type * as hast from 'hast';
import { toHtml } from 'hast-util-to-html';
import { h } from 'hastscript';
import type { Raw } from 'mdast-util-to-hast';
import fs from 'node:fs';
import rehype from 'rehype';
import { visit, EXIT } from 'unist-util-visit';
import upath from 'upath';
import MIMEType from 'whatwg-mimetype';
import type { ManuscriptEntry } from '../config/resolve.js';
import type {
  StructuredDocument,
  StructuredDocumentSection,
} from '../config/schema.js';
import { Logger } from '../logger.js';
import { decodePublicationManifest } from '../output/webbook.js';
import type { PublicationManifest } from '../schema/publication.schema.js';
import {
  DetailError,
  assertPubManifestSchema,
  writeFileIfChanged,
} from '../util.js';

// ---------------------------------------------------------------------------
// Helpers for working with hast trees
// ---------------------------------------------------------------------------

/** Parse an HTML string into a hast Root using rehype. */
function parseHtml(html: string): hast.Root {
  return rehype()
    .data('settings', { fragment: false })
    .parse(html) as unknown as hast.Root;
}

/** Extract the concatenated text content from a hast node. */
function textContent(node: hast.Root | hast.Element): string {
  let text = '';
  visit(node, 'text', (t) => {
    text += t.value;
  });
  return text;
}

/**
 * Simple sanitizer replacing DOMPurify: strips `javascript:` hrefs and
 * removes event-handler properties from elements.
 */
function sanitizeTree(tree: hast.Root | hast.Element): void {
  visit(tree, 'element', (node) => {
    if (!node.properties) return;
    // Strip javascript: from href
    if (
      typeof node.properties.href === 'string' &&
      /^\s*javascript:/i.test(node.properties.href)
    ) {
      delete node.properties.href;
    }
    // Remove event handler attributes (on*)
    for (const key of Object.keys(node.properties)) {
      if (/^on[A-Z]/i.test(key)) {
        delete node.properties[key];
      }
    }
  });
}

/**
 * Find the first element matching a predicate via depth-first visit.
 * Returns the element or undefined.
 */
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

/**
 * Find all elements matching a predicate.
 */
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

/**
 * Find <head> element in a hast tree.
 */
function findHead(tree: hast.Root): hast.Element | undefined {
  return findElement(tree, (n) => n.tagName === 'head');
}

// ---------------------------------------------------------------------------
// ResourceFetcher — replaces the JSDOM-based ResourceLoader
//
// @vivliostyle/jsdom resource-loader.js:71 fetch() handles http(s), file,
// and data URL schemes. This class replaces that with globalThis.fetch for
// http(s) and fs.readFileSync for file: URLs.
//
// Sub-resource discovery (discoverSubResources) replaces the implicit
// fetching that JSDOM performs during HTML parsing. The following elements
// are covered, matching JSDOM's behavior:
//
//   <link rel="stylesheet"> — HTMLLinkElement-impl.js:95 fetchStylesheet()
//   <img src>               — HTMLImageElement-impl.js:117 resourceLoader.fetch()
//   <frame>/<iframe> src    — HTMLFrameElement-impl.js:92 resourceLoader.fetch()
//
// NOT fetched (matching JSDOM when runScripts is not "dangerously"):
//   <script src>            — HTMLScriptElement-impl.js:53 _canRunScript()
//
// NOT YET IMPLEMENTED:
//   CSS @import (recursive)  — stylesheets.js:95 scanForImportRules()
//   JSDOM recursively fetches @import rules from loaded stylesheets.
//   This is not yet replicated here.
// ---------------------------------------------------------------------------

export class ResourceFetcher {
  static dataUrlOrigin = 'http://localhost/' as const;

  fetcherMap = new Map<
    string,
    Promise<{ buffer: Buffer; contentType?: string }>
  >();

  // resource-loader.js:71 fetch() — protocol dispatch
  async fetch(url: string): Promise<Buffer | null> {
    Logger.debug(`Fetching resource: ${url}`);
    const fetchPromise = (async () => {
      // resource-loader.js:119 case "file" — fs read
      if (url.startsWith('file:')) {
        const { fileURLToPath } = await import('node:url');
        const filePath = fileURLToPath(url);
        const buffer = fs.readFileSync(filePath);
        const { default: mime } = await import('mime-types');
        const contentType = mime.lookup(filePath) || undefined;
        return { buffer, contentType };
      }
      // resource-loader.js:82 case "http"/"https" — network fetch
      const response = await globalThis.fetch(url);
      const buffer = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') ?? undefined;
      return { buffer, contentType };
    })();
    this.fetcherMap.set(url, fetchPromise);
    try {
      const { buffer } = await fetchPromise;
      return buffer;
    } catch {
      return null;
    }
  }

  /**
   * Discovers sub-resources in a parsed hast tree that would have been
   * implicitly fetched by JSDOM's resource loader during HTML parsing.
   */
  discoverSubResources(tree: hast.Root, baseUrl: string): string[] {
    const urls: string[] = [];
    visit(tree, 'element', (node) => {
      // <link rel="stylesheet" href="...">
      // → HTMLLinkElement-impl.js:79 fetchAndProcess() → :95 fetchStylesheet()
      if (
        node.tagName === 'link' &&
        [node.properties?.rel].flat().includes('stylesheet') &&
        node.properties?.href
      ) {
        urls.push(new URL(String(node.properties.href), baseUrl).href);
      }
      // <img src="...">
      // → HTMLImageElement-impl.js:117 resourceLoader.fetch()
      if (node.tagName === 'img' && node.properties?.src) {
        urls.push(new URL(String(node.properties.src), baseUrl).href);
      }
      // <iframe src="..."> / <frame src="...">
      // → HTMLFrameElement-impl.js:92 resourceLoader.fetch()
      if (
        (node.tagName === 'iframe' || node.tagName === 'frame') &&
        node.properties?.src
      ) {
        urls.push(new URL(String(node.properties.src), baseUrl).href);
      }
      // NOTE: <script src> is NOT fetched — equivalent to @vivliostyle/jsdom
      // → HTMLScriptElement-impl.js:53 _canRunScript() guards fetch;
      //   vivliostyle-cli does not set runScripts: "dangerously"
    });
    // TODO: stylesheets.js:95 scanForImportRules() — after fetching CSS,
    // JSDOM recursively resolves @import rules. Not yet implemented here.
    return urls;
  }

  async fetchSubResources(tree: hast.Root, baseUrl: string): Promise<void> {
    const urls = this.discoverSubResources(tree, baseUrl);
    await Promise.allSettled(
      urls.map((url) => {
        if (!this.fetcherMap.has(url)) {
          return this.fetch(url);
        }
      }),
    );
  }

  static async saveFetchedResources({
    fetcherMap,
    rootUrl,
    outputDir,
    onError,
  }: {
    fetcherMap: Map<string, Promise<{ buffer: Buffer; contentType?: string }>>;
    rootUrl: string;
    outputDir: string;
    onError?: (error: Error) => void;
  }) {
    const rootHref = rootUrl.startsWith('data:')
      ? ResourceFetcher.dataUrlOrigin
      : /^https?:/i.test(rootUrl)
        ? new URL('/', rootUrl).href
        : new URL('.', rootUrl).href;

    const normalizeToLocalPath = (urlString: string, mimeType?: string) => {
      let url = new URL(urlString);
      url.hash = '';
      if (mimeType === 'text/html' && !/\.html?$/.test(url.pathname)) {
        url.pathname = `${url.pathname.replace(/\/$/, '')}/index.html`;
      }
      let relTarget = upath.relative(rootHref, url.href);
      return decodeURI(relTarget);
    };

    const fetchedResources: { url: string; encodingFormat?: string }[] = [];
    await Promise.allSettled(
      [...fetcherMap.entries()].flatMap(async ([url, fetcher]) => {
        if (!url.startsWith(rootHref)) {
          return [];
        }
        return (
          fetcher
            .then(async ({ buffer, contentType }) => {
              let encodingFormat: string | undefined;
              try {
                if (contentType) {
                  encodingFormat = new MIMEType(contentType).essence;
                }
                /* v8 ignore next 3 */
              } catch (e) {
                /* NOOP */
              }
              const relTarget = normalizeToLocalPath(url, encodingFormat);
              const target = upath.join(outputDir, relTarget);
              fetchedResources.push({ url: relTarget, encodingFormat });
              writeFileIfChanged(target, buffer);
            })
            /* v8 ignore next */
            .catch(onError)
        );
      }),
    );
    return fetchedResources;
  }
}

// ---------------------------------------------------------------------------
// getStructuredSectionFromHtml — reads an HTML file, extracts heading structure
// ---------------------------------------------------------------------------

export async function getStructuredSectionFromHtml(
  htmlPath: string,
  href?: string,
) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const tree = parseHtml(html);

  // Collect headings, excluding those inside <blockquote>
  const headingTagNames = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

  const allHeadings: hast.Element[] = [];

  // We need to track ancestors to exclude blockquote descendants.
  // Use a recursive walker instead of visit() to track ancestors.
  function walkForHeadings(
    node: hast.Root | hast.Element,
    insideBlockquote: boolean,
  ): void {
    if (node.type === 'element') {
      if (node.tagName === 'blockquote') {
        insideBlockquote = true;
      }
      if (headingTagNames.has(node.tagName) && !insideBlockquote) {
        allHeadings.push(node);
      }
    }
    if ('children' in node) {
      for (const child of node.children) {
        if (child.type === 'element') {
          walkForHeadings(child, insideBlockquote);
        }
      }
    }
  }
  walkForHeadings(tree, false);

  // visit() traverses in document order, so no sorting needed

  function traverse(headers: hast.Element[]): StructuredDocumentSection[] {
    if (headers.length === 0) {
      return [];
    }
    const [head, ...tail] = headers;
    // Get the section (parent) element for id lookup
    const parentId = findParentId(tree, head);
    const headId =
      head.properties?.id != null ? String(head.properties.id) : undefined;
    const id = headId || parentId;
    const level = Number(head.tagName.slice(1));

    // Sanitize heading inner HTML
    const headingClone: hast.Element = JSON.parse(JSON.stringify(head));
    sanitizeTree(headingClone);
    const headingHtml = toHtml(headingClone.children, {
      allowDangerousHtml: true,
    });
    const headingText = textContent(head).trim().replace(/\s+/g, ' ') || '';

    let i = tail.findIndex((s) => Number(s.tagName.slice(1)) <= level);
    i = i === -1 ? tail.length : i;
    return [
      {
        headingHtml,
        headingText,
        level,
        ...(href && id && { href: `${href}#${encodeURIComponent(id)}` }),
        ...(id && { id }),
        children: traverse(tail.slice(0, i)),
      },
      ...traverse(tail.slice(i)),
    ];
  }
  return traverse(allHeadings);
}

/**
 * Walk the tree to find the parent element of `target` and return its id.
 */
function findParentId(
  tree: hast.Root,
  target: hast.Element,
): string | undefined {
  function search(
    node: hast.Root | hast.Element,
    parent?: hast.Element,
  ): string | undefined {
    if (node === target) {
      return parent?.properties?.id != null
        ? String(parent.properties.id)
        : undefined;
    }
    if ('children' in node) {
      for (const child of node.children) {
        if (child.type === 'element') {
          const result = search(
            child,
            node.type === 'element' ? (node as hast.Element) : parent,
          );
          if (result !== undefined) return result;
        }
      }
    }
    return undefined;
  }
  return search(tree);
}

// ---------------------------------------------------------------------------
// TOC style
// ---------------------------------------------------------------------------

const getTocHtmlStyle = ({
  pageBreakBefore,
  pageCounterReset,
}: {
  pageBreakBefore?: 'recto' | 'verso' | 'left' | 'right';
  pageCounterReset?: number;
}) => {
  if (!pageBreakBefore && typeof pageCounterReset !== 'number') {
    return null;
  }
  return /* css */ `
${
  pageBreakBefore
    ? /* css */ `:root {
  break-before: ${pageBreakBefore};
}`
    : ''
}
${
  // Note: `--vs-document-first-page-counter-reset` is reserved variable name in Vivliostyle base themes
  typeof pageCounterReset === 'number'
    ? /* css */ `@page :nth(1) {
  --vs-document-first-page-counter-reset: page ${Math.floor(pageCounterReset - 1)};
  counter-reset: var(--vs-document-first-page-counter-reset);
}`
    : ''
}
`;
};

// ---------------------------------------------------------------------------
// JSX-based helpers (unchanged — these use hastscript@9 / hast@3 via JSX)
// ---------------------------------------------------------------------------

type HastElement = hast.ElementContent | hast.Root;

export const defaultTocTransform = {
  transformDocumentList:
    (nodeList: StructuredDocument[]) =>
    (propsList: { children: HastElement | HastElement[] }[]): HastElement => {
      return h(
        'ol',
        nodeList
          .map((a, i) => [a, propsList[i]] as const)
          .flatMap(([{ href, title, sections }, { children }]) => {
            // don't display the document title if it has only one top-level H1 heading
            if (sections?.length === 1 && sections[0].level === 1) {
              return [children].flat().flatMap((e) => {
                if (e.type === 'element' && e.tagName === 'ol') {
                  return e.children;
                }
                return e;
              });
            }
            return h('li', h('a', { href }, title), children);
          }),
      );
    },
  transformSectionList:
    (nodeList: StructuredDocumentSection[]) =>
    (propsList: { children: HastElement | HastElement[] }[]): HastElement => {
      return h(
        'ol',
        nodeList
          .map((a, i) => [a, propsList[i]] as const)
          .map(([{ headingHtml, href, level }, { children }]) => {
            const headingContent: Raw = {
              type: 'raw',
              value: headingHtml,
            };
            return h(
              'li',
              { 'data-section-level': level },
              href
                ? h('a', { href }, headingContent)
                : h('span', headingContent),
              children,
            );
          }),
      );
    },
};

export function generateDefaultTocHtml({
  language,
  title,
}: {
  language?: string;
  title?: string;
}) {
  const toc = (
    <html lang={language}>
      <head>
        <meta charset="utf-8" />
        <title>{title || ''}</title>
        <style data-vv-style></style>
      </head>
      <body>
        <h1>{title || ''}</h1>
        <nav id="toc" role="doc-toc" />
      </body>
    </html>
  );
  return toHtml(toc);
}

export async function generateTocListSection({
  entries,
  distDir,
  sectionDepth,
  transform = {},
}: {
  entries: Pick<ManuscriptEntry, 'target' | 'title'>[];
  distDir: string;
  sectionDepth: number;
  transform?: Partial<typeof defaultTocTransform>;
}): Promise<string> {
  const {
    transformDocumentList = defaultTocTransform.transformDocumentList,
    transformSectionList = defaultTocTransform.transformSectionList,
  } = transform;

  const structure = await Promise.all(
    entries.map(async (entry) => {
      const href = encodeURI(upath.relative(distDir, entry.target));
      const sections =
        sectionDepth >= 1
          ? await getStructuredSectionFromHtml(entry.target, href)
          : [];
      return {
        title: entry.title || upath.basename(entry.target, '.html'),
        href: encodeURI(upath.relative(distDir, entry.target)),
        sections,
        children: [], // TODO
      };
    }),
  );
  const docToc = transformDocumentList(structure)(
    structure.map((doc) => {
      function renderSectionList(
        sections: StructuredDocumentSection[],
      ): HastElement | HastElement[] {
        const nodeList = sections.flatMap((section) => {
          if (section.level > sectionDepth) {
            return [];
          }
          return section;
        });
        if (nodeList.length === 0) {
          return [];
        }
        return transformSectionList(nodeList)(
          nodeList.map((node) => ({
            children: [renderSectionList(node.children || [])].flat(),
          })),
        );
      }
      return {
        children: [renderSectionList(doc.sections || [])].flat(),
      };
    }),
  );

  return toHtml(docToc, { allowDangerousHtml: true });
}

// ---------------------------------------------------------------------------
// processTocHtml — now operates on hast Root instead of JSDOM
// ---------------------------------------------------------------------------

export async function processTocHtml(
  tree: hast.Root,
  {
    manifestPath,
    tocTitle,
    styleOptions = {},
    entries,
    distDir,
    sectionDepth,
    transform,
  }: Parameters<typeof generateTocListSection>[0] & {
    manifestPath: string;
    tocTitle: string;
    styleOptions?: Parameters<typeof getTocHtmlStyle>[0];
  },
): Promise<hast.Root> {
  // Ensure a <link rel="publication" ...> exists in <head>
  const existingPubLink = findElement(
    tree,
    (n) =>
      n.tagName === 'link' &&
      [n.properties?.rel].flat().includes('publication') &&
      n.properties?.type === 'application/ld+json',
  );
  if (!existingPubLink) {
    const head = findHead(tree);
    if (head) {
      head.children.push({
        type: 'element',
        tagName: 'link',
        properties: {
          rel: 'publication',
          type: 'application/ld+json',
          href: encodeURI(upath.relative(distDir, manifestPath)),
        },
        children: [],
      });
    }
  }

  // Handle <style data-vv-style>
  const styleEl = findElement(
    tree,
    (n) => n.tagName === 'style' && n.properties?.dataVvStyle !== undefined,
  );
  if (styleEl) {
    const styleText = getTocHtmlStyle(styleOptions);
    if (styleText) {
      styleEl.children = [{ type: 'text', value: styleText }];
    } else {
      // Remove the style element from its parent
      removeElement(tree, styleEl);
    }
  }

  // Find <nav> or [role="doc-toc"]
  const nav = findElement(
    tree,
    (n) => n.tagName === 'nav' || n.properties?.role === 'doc-toc',
  );
  if (
    nav &&
    nav.children.filter((c) => c.type !== 'text' || c.value.trim()).length === 0
  ) {
    // Nav is empty — populate it
    const h2: hast.Element = {
      type: 'element',
      tagName: 'h2',
      properties: {},
      children: [{ type: 'text', value: tocTitle }],
    };
    nav.children.push(h2);

    const tocHtmlString = await generateTocListSection({
      entries,
      distDir,
      sectionDepth,
      transform,
    });
    const tocTree = parseHtml(tocHtmlString);
    // Extract the body content from the parsed fragment
    const body = findElement(tocTree, (n) => n.tagName === 'body');
    if (body) {
      nav.children.push(...body.children);
    } else {
      for (const c of tocTree.children) {
        if (c.type !== 'doctype') {
          nav.children.push(c);
        }
      }
    }
  }
  return tree;
}

// ---------------------------------------------------------------------------
// Cover HTML
// ---------------------------------------------------------------------------

const getCoverHtmlStyle = ({
  pageBreakBefore,
}: {
  pageBreakBefore?: 'recto' | 'verso' | 'left' | 'right';
}) => /* css */ `
${
  pageBreakBefore
    ? `:root {
  break-before: ${pageBreakBefore};
}`
    : ''
}
body {
  margin: 0;
}
[role="doc-cover"] {
  display: block;
  width: 100vw;
  height: 100vh;
  object-fit: contain;
}
@page {
  margin: 0;
}
`;

export function generateDefaultCoverHtml({
  language,
  title,
}: {
  language?: string;
  title?: string;
}) {
  const toc = (
    <html lang={language}>
      <head>
        <meta charset="utf-8" />
        <title>{title || ''}</title>
        <style data-vv-style></style>
      </head>
      <body>
        <section role="region" aria-label="Cover">
          <img role="doc-cover" />
        </section>
      </body>
    </html>
  );
  return toHtml(toc);
}

// ---------------------------------------------------------------------------
// processCoverHtml — now operates on hast Root instead of JSDOM
// ---------------------------------------------------------------------------

export async function processCoverHtml(
  tree: hast.Root,
  {
    imageSrc,
    imageAlt,
    styleOptions = {},
  }: {
    imageSrc: string;
    imageAlt: string;
    styleOptions?: Parameters<typeof getCoverHtmlStyle>[0];
  },
): Promise<hast.Root> {
  // Handle <style data-vv-style>
  const styleEl = findElement(
    tree,
    (n) => n.tagName === 'style' && n.properties?.dataVvStyle !== undefined,
  );
  if (styleEl) {
    const styleText = getCoverHtmlStyle(styleOptions);
    if (styleText) {
      styleEl.children = [{ type: 'text', value: styleText }];
    } else {
      removeElement(tree, styleEl);
    }
  }

  // Find <img role="doc-cover">
  const cover = findElement(
    tree,
    (n) => n.tagName === 'img' && n.properties?.role === 'doc-cover',
  );
  if (cover) {
    if (!cover.properties?.src) {
      cover.properties = cover.properties || {};
      cover.properties.src = encodeURI(imageSrc);
    }
    if (!cover.properties?.alt) {
      cover.properties = cover.properties || {};
      cover.properties.alt = imageAlt;
    }
  }
  return tree;
}

// ---------------------------------------------------------------------------
// fetchLinkedPublicationManifest — now operates on hast Root
// ---------------------------------------------------------------------------

export async function fetchLinkedPublicationManifest({
  tree,
  resourceFetcher,
  baseUrl,
}: {
  tree: hast.Root;
  resourceFetcher: ResourceFetcher;
  baseUrl: string;
}): Promise<{ manifest: PublicationManifest; manifestUrl: string } | null> {
  const linkEl = findElement(
    tree,
    (n) =>
      n.tagName === 'link' &&
      n.properties?.href != null &&
      [n.properties?.rel].flat().includes('publication'),
  );
  if (!linkEl) {
    return null;
  }
  const href = String(linkEl.properties!.href).trim();
  let manifest: PublicationManifest;
  let manifestUrl = baseUrl;
  if (href.startsWith('#')) {
    const id = href.slice(1);
    const scriptEl = findElement(
      tree,
      (n) =>
        n.properties?.id === id && n.properties?.type === 'application/ld+json',
    );
    if (!scriptEl) {
      return null;
    }
    Logger.debug(`Found embedded publication manifest: ${href}`);
    try {
      manifest = JSON.parse(toHtml(scriptEl.children));
    } catch (error) {
      const thrownError = error as Error;
      throw new DetailError(
        'Failed to parse manifest data',
        typeof thrownError.stack,
      );
    }
  } else {
    Logger.debug(`Found linked publication manifest: ${href}`);
    const url = new URL(href, baseUrl);
    manifestUrl = url.href;
    const buffer = await resourceFetcher.fetch(url.href);
    if (!buffer) {
      throw new Error(`Failed to fetch manifest JSON file: ${url.href}`);
    }
    const manifestJson = buffer.toString();
    try {
      manifest = JSON.parse(manifestJson);
    } catch (error) {
      const thrownError = error as Error;
      throw new DetailError(
        'Failed to parse manifest data',
        typeof thrownError.stack,
      );
    }
  }

  try {
    assertPubManifestSchema(manifest);
  } catch (error) {
    Logger.logWarn(
      `Publication manifest validation failed. Processing continues, but some problems may occur.\n${error}`,
    );
  }
  return {
    manifest: decodePublicationManifest(manifest),
    manifestUrl,
  };
}

// ---------------------------------------------------------------------------
// parseTocDocument / parsePageListDocument — now operate on hast Root
// ---------------------------------------------------------------------------

export type TocResourceTreeItem = {
  element: hast.Element;
  label: hast.Element;
  children?: TocResourceTreeItem[];
};
export type TocResourceTreeRoot = {
  element: hast.Element;
  heading?: hast.Element;
  children: TocResourceTreeItem[];
};

export function parseTocDocument(tree: hast.Root): TocResourceTreeRoot | null {
  const docTocElements = findAllElements(
    tree,
    (n) => n.properties?.role === 'doc-toc',
  );
  if (docTocElements.length === 0) {
    return null;
  }
  const tocRoot = docTocElements[0];

  const parseTocItem = (element: hast.Element): TocResourceTreeItem | null => {
    if (element.tagName !== 'li') {
      return null;
    }
    const elementChildren = element.children.filter(
      (c): c is hast.Element => c.type === 'element',
    );
    const label = elementChildren[0];
    const ol = elementChildren[1];
    if (!label || (label.tagName !== 'a' && label.tagName !== 'span')) {
      return null;
    }
    if (!ol || ol.tagName !== 'ol') {
      return { element, label };
    }
    const olChildren = ol.children.filter(
      (c): c is hast.Element => c.type === 'element',
    );
    const children = olChildren.reduce<TocResourceTreeItem[] | null>(
      (acc, val) => {
        if (!acc) {
          return acc;
        }
        const res = parseTocItem(val);
        return res && [...acc, res];
      },
      [],
    );
    return (
      children && {
        element,
        label,
        children,
      }
    );
  };

  let heading: hast.Element | undefined;
  const tocRootChildren = tocRoot.children.filter(
    (c): c is hast.Element => c.type === 'element',
  );
  for (let child of tocRootChildren) {
    if (child.tagName === 'ol') {
      const olChildren = child.children.filter(
        (c): c is hast.Element => c.type === 'element',
      );
      const children = olChildren.reduce<TocResourceTreeItem[] | null>(
        (acc, val) => {
          if (!acc) {
            return acc;
          }
          const res = parseTocItem(val);
          return res && [...acc, res];
        },
        [],
      );
      return children && { element: tocRoot, heading, children };
    } else if (
      ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hgroup'].includes(child.tagName)
    ) {
      heading = child;
    } else {
      return null;
    }
  }
  return null;
}

export type PageListResourceTreeItem = {
  element: hast.Element;
};
export type PageListResourceTreeRoot = {
  element: hast.Element;
  heading?: hast.Element;
  children: PageListResourceTreeItem[];
};

export function parsePageListDocument(
  tree: hast.Root,
): PageListResourceTreeRoot | null {
  const docPageListElements = findAllElements(
    tree,
    (n) => n.properties?.role === 'doc-pagelist',
  );
  if (docPageListElements.length === 0) {
    return null;
  }
  const pageListRoot = docPageListElements[0];

  let heading: hast.Element | undefined;
  const pageListChildren = pageListRoot.children.filter(
    (c): c is hast.Element => c.type === 'element',
  );
  for (let child of pageListChildren) {
    if (child.tagName === 'ol') {
      const olChildren = child.children.filter(
        (c): c is hast.Element => c.type === 'element',
      );
      const children = olChildren.reduce<PageListResourceTreeItem[] | null>(
        (acc, element) => {
          return (
            acc && (element.tagName === 'li' ? [...acc, { element }] : null)
          );
        },
        [],
      );
      return children && { element: pageListRoot, heading, children };
    } else if (
      ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hgroup'].includes(child.tagName)
    ) {
      heading = child;
    } else {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal helper: remove an element from its parent in the hast tree
// ---------------------------------------------------------------------------

function removeElement(tree: hast.Root, target: hast.Element): void {
  visit(tree, 'element', (node, index, parent) => {
    if (node === target && parent && index != null) {
      parent.children.splice(index, 1);
      return EXIT;
    }
  });
  // Also check root children
  const idx = tree.children.indexOf(target);
  if (idx !== -1) {
    tree.children.splice(idx, 1);
  }
}
