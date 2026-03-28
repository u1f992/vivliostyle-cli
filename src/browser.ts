import { serveBrowser } from '@vivliostyle/serve-browser';
import net from 'node:net';
import type { Browser, HTTPRequest, Page } from 'puppeteer-core';
import type { ResolvedTaskConfig } from './config/resolve.js';
import type { BrowserType } from './config/schema.js';
import { launchContainerBrowser } from './container.js';
import { Logger } from './logger.js';
import { importNodeModule } from './node-modules.js';
import { isRunningOnWSL, registerExitHandler } from './util.js';

function buildVivliostyleArgs({
  browserType,
  mode,
  noSandbox,
  disableDevShmUsage,
  proxy,
}: {
  browserType: BrowserType;
  mode: 'preview' | 'build';
  noSandbox: boolean;
  disableDevShmUsage: boolean;
  proxy:
    | {
        server: string;
        bypass: string | undefined;
      }
    | undefined;
}): string[] {
  const args: string[] = [];

  if (mode === 'build') {
    args.push('--headless');
  }

  // https://github.com/microsoft/playwright/blob/35709546cd4210b7744943ceb22b92c1b126d48d/packages/playwright-core/src/server/chromium/chromium.ts
  if (browserType === 'chrome' || browserType === 'chromium') {
    args.push(
      '--disable-field-trial-config',
      '--disable-back-forward-cache',
      '--disable-component-update',
      '--no-default-browser-check',
      '--disable-features=AcceptCHFrame,AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument',
      '--enable-features=CDPScreenshotNewSurface',
      '--no-service-autorun',
      '--unsafely-disable-devtools-self-xss-warnings',
      '--edge-skip-compat-layer-relaunch',
    );

    if (process.platform === 'darwin') {
      args.push('--enable-unsafe-swiftshader');
    }
    if (noSandbox) {
      args.push('--no-sandbox');
    }
    if (mode === 'build') {
      args.push(
        '--hide-scrollbars',
        '--mute-audio',
        '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
      );
    }
    if (proxy?.server) {
      const proxyURL = new URL(proxy.server);
      const isSocks = proxyURL.protocol === 'socks5:';
      if (isSocks) {
        args.push(
          `--host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE ${proxyURL.hostname}"`,
        );
      }
      args.push(`--proxy-server=${proxy.server}`);
      const proxyBypassRules = [];
      if (proxy.bypass) {
        proxyBypassRules.push(
          ...proxy.bypass
            .split(',')
            .map((t) => t.trim())
            .map((t) => (t.startsWith('.') ? '*' + t : t)),
        );
      }
      proxyBypassRules.push('<-loopback>');
      args.push(`--proxy-bypass-list=${proxyBypassRules.join(';')}`);
    }
    // #579: disable web security to allow cross-origin requests
    args.push('--disable-web-security');
    if (disableDevShmUsage) {
      args.push('--disable-dev-shm-usage');
    }
    // #357: Set devicePixelRatio=1 otherwise it causes layout issues in HiDPI displays
    if (mode === 'build') {
      args.push('--force-device-scale-factor=1');
    }
    // #565: Add --disable-gpu option when running on WSL
    if (isRunningOnWSL()) {
      args.push('--disable-gpu');
    }
    // set Chromium language to English to avoid locale-dependent issues
    args.push('--lang=en');
    if (mode !== 'build' && process.platform === 'darwin') {
      args.push('-AppleLanguages', '(en)');
    }
  }
  // TODO: Investigate appropriate settings on Firefox

  return args;
}

export async function launchPreview({
  mode,
  url,
  renderMode = 'local',
  onBrowserOpen,
  onPageOpen,
  config: {
    browser: browserConfig,
    proxy,
    sandbox,
    ignoreHttpsErrors,
    timeout,
    image,
  },
}: {
  mode: 'preview' | 'build';
  url: string;
  renderMode?: 'local' | 'docker';
  onBrowserOpen?: (browser: Browser) => void | Promise<void>;
  onPageOpen?: (page: Page) => void | Promise<void>;
  config: Pick<
    ResolvedTaskConfig,
    'browser' | 'proxy' | 'sandbox' | 'ignoreHttpsErrors' | 'timeout' | 'image'
  >;
}) {
  const puppeteer = await importNodeModule('puppeteer-core');

  const args = buildVivliostyleArgs({
    browserType: browserConfig.type,
    mode,
    noSandbox: !sandbox,
    disableDevShmUsage: renderMode === 'docker',
    proxy,
  });

  let wsEndpoint: string;

  if (renderMode === 'docker') {
    // Docker mode: launch serve-browser in a container
    // Find an available port starting from 9222, similar to Vite's port allocation
    let port = 9222;
    while (
      await new Promise<boolean>((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(true));
        server.listen(port, () => server.close(() => resolve(false)));
      })
    ) {
      port++;
    }
    const container = await launchContainerBrowser({
      image,
      browserType: browserConfig.type,
      tag: browserConfig.tag,
      port,
      args,
    });
    wsEndpoint = container.wsEndpoint;
    registerExitHandler('Stopping browser container', container.stop);
  } else {
    // Local mode: use serve-browser API
    const server = await serveBrowser({
      browser: browserConfig.type,
      tag: browserConfig.tag,
      args,
    });
    wsEndpoint = server.wsEndpoint;
    registerExitHandler('Closing browser', async () => {
      await server[Symbol.asyncDispose]();
    });
  }

  Logger.debug(`Connecting to browser at ${wsEndpoint}`);
  const browser = await puppeteer.connect({
    browserWSEndpoint: wsEndpoint,
    acceptInsecureCerts: ignoreHttpsErrors,
    protocolTimeout: timeout,
  });
  await onBrowserOpen?.(browser);

  const [browserContext] = browser.browserContexts();
  const page =
    (await browserContext.pages())[0] ?? (await browserContext.newPage());
  await page.setViewport(
    mode === 'build'
      ? // This viewport size is important to detect headless environment in Vivliostyle viewer
        // https://github.com/vivliostyle/vivliostyle.js/blob/73bcf323adcad80126b0175630609451ccd09d8a/packages/core/src/vivliostyle/vgen.ts#L2489-L2500
        { width: 800, height: 600 }
      : null,
  );
  await onPageOpen?.(page);

  // Prevent confirm dialog from being auto-dismissed
  page.on('dialog', () => {});

  if (proxy?.username && proxy?.password) {
    await page.authenticate({
      username: proxy.username,
      password: proxy.password,
    });
  }

  // In Docker mode, the container browser cannot reach the host's Vite server
  // directly. Intercept requests and proxy them through the CDP connection.
  if (renderMode === 'docker') {
    await page.setRequestInterception(true);
    const viteOrigin = new URL(url).origin;
    page.on('request', async (request: HTTPRequest) => {
      const requestUrl = request.url();
      if (requestUrl.startsWith(viteOrigin)) {
        try {
          const response = await fetch(requestUrl);
          const body = Buffer.from(await response.arrayBuffer());
          const headers: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            headers[key] = value;
          });
          await request.respond({
            status: response.status,
            headers,
            body,
          });
        } catch (error) {
          Logger.debug(`Proxy fetch failed for ${requestUrl}: ${error}`);
          await request.abort('connectionrefused');
        }
      } else {
        await request.continue();
      }
    });
  }

  await page.goto(url);

  return { browser, page };
}
