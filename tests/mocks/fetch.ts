import { vi } from 'vitest';

const mocked = await vi.hoisted(async () => {
  const { fs: memfs } = await import('memfs');
  const { lookup: mime } = await import('mime-types');
  const path = await import('node:path');

  function mapToLocalPath(urlString: string): string {
    const url = new URL(urlString);
    let pathname = url.pathname;
    if (!path.extname(pathname)) {
      pathname = path.posix.join(pathname, 'index.html');
    }
    return decodeURI(pathname);
  }

  const originalFetch = globalThis.fetch;

  const mockedFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (/^https?:/.test(url)) {
      const localPath = mapToLocalPath(url);
      const buffer = memfs.readFileSync(localPath) as Buffer;
      const contentType = mime(localPath) || 'text/html';
      return new Response(buffer, {
        status: 200,
        headers: { 'content-type': contentType },
      });
    }
    return originalFetch(input, init);
  };

  return { mockedFetch };
});

vi.stubGlobal('fetch', mocked.mockedFetch);
