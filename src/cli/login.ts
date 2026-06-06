import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { apiUrl, saveConfig } from './config.js';

// `givework login` — browser-based OAuth with a loopback callback (no copy-paste).
// We start a one-shot local HTTP server, open the browser to the control plane's
// /auth/github/login?cli=<port>, and the server-side callback redirects the minted
// dev token straight back to http://127.0.0.1:<port>/callback?token=…

/** Best-effort: open a URL in the user's default browser. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {}); // swallow — we print the URL as a fallback anyway
    child.unref();
  } catch {
    /* fall back to the printed URL */
  }
}

const SUCCESS_HTML = `<!doctype html><meta charset="utf-8"><title>Givework</title>
<body style="font:16px system-ui,sans-serif;max-width:540px;margin:4rem auto;text-align:center">
<h1>✓ Signed in</h1><p>You can close this tab and return to your terminal.</p></body>`;

const TIMEOUT_MS = 120_000;

/** Run the loopback server until it captures a token (or times out). */
function awaitToken(base: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let server: Server;
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('login timed out after 2 minutes'));
    }, TIMEOUT_MS);

    const settle = (fn: () => void) => {
      clearTimeout(timer);
      server.close();
      fn();
    };

    server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (reqUrl.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const token = reqUrl.searchParams.get('token');
      res.writeHead(token ? 200 : 400, { 'content-type': 'text/html' });
      res.end(token ? SUCCESS_HTML : 'Missing token');
      // Only settle on a real token. A tokenless /callback hit (browser prefetch,
      // an extension, a port scanner) must NOT abort the flow — keep listening and
      // let the timeout be the only failure path.
      if (token) settle(() => resolve(token));
    });

    server.on('error', (err) => settle(() => reject(err)));
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const loginUrl = `${base}/auth/github/login?cli=${port}`;
      console.log(`Opening your browser to sign in…\nIf it doesn't open, visit:\n  ${loginUrl}\n`);
      openBrowser(loginUrl);
    });
  });
}

export async function login(): Promise<void> {
  const base = apiUrl();
  const token = await awaitToken(base);
  saveConfig({ apiUrl: base, token });
  console.log('✓ Logged in. Token saved to ~/.givework/config.json');
}
