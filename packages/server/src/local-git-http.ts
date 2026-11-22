import { execFile, spawn } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let cachedGitHttpBackendPath: string | null = null;

async function resolveGitHttpBackend(): Promise<string> {
  if (cachedGitHttpBackendPath) return cachedGitHttpBackendPath;
  const { stdout } = await execFileAsync("git", ["--exec-path"]);
  cachedGitHttpBackendPath = `${stdout.trim()}/git-http-backend`;
  return cachedGitHttpBackendPath;
}

/**
 * Starts a real Git Smart-HTTP server backed by `git-http-backend` serving all bare repos
 * under `projectRoot` (e.g. `<projectRoot>/demo/app.git` served at `/demo/app.git`).
 * Used for local self-hosted upstreams, integration tests, and live demos.
 */
export async function startLocalGitHttpServer(options: {
  projectRoot: string;
  port?: number;
  requiredToken?: string;
}): Promise<{ server: http.Server; url: string; close: () => Promise<void> }> {
  const backendBin = await resolveGitHttpBackend();

  const server = http.createServer((req, res) => {
    if (options.requiredToken) {
      const auth = req.headers.authorization ?? "";
      const expected = Buffer.from(`git:${options.requiredToken}`).toString("base64");
      const expectedGh = Buffer.from(`x-access-token:${options.requiredToken}`).toString("base64");
      const expectedGl = Buffer.from(`oauth2:${options.requiredToken}`).toString("base64");
      if (
        auth !== `Basic ${expected}` &&
        auth !== `Basic ${expectedGh}` &&
        auth !== `Basic ${expectedGl}`
      ) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="local-upstream"' });
        res.end("Unauthorized");
        return;
      }
    }

    const parsedUrl = new URL(req.url ?? "/", "http://localhost");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_PROJECT_ROOT: options.projectRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: parsedUrl.pathname,
      QUERY_STRING: parsedUrl.search.replace(/^\?/, ""),
      REQUEST_METHOD: req.method ?? "GET",
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      REMOTE_USER: "upstream-service",
      REMOTE_ADDR: "127.0.0.1",
    };
    if (req.headers["content-length"]) {
      env.CONTENT_LENGTH = req.headers["content-length"];
    }
    if (req.headers["content-encoding"]) {
      env.HTTP_CONTENT_ENCODING = String(req.headers["content-encoding"]);
    }
    if (req.headers["git-protocol"]) {
      env.HTTP_GIT_PROTOCOL = String(req.headers["git-protocol"]);
    }

    const child = spawn(backendBin, [], { env });
    req.pipe(child.stdin);

    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", () => {
      // ignore git-http-backend stderr chatter
    });

    child.on("close", () => {
      const output = Buffer.concat(chunks);
      const sep = output.indexOf("\r\n\r\n");
      const sepLen = sep >= 0 ? 4 : 2;
      const headerEnd = sep >= 0 ? sep : output.indexOf("\n\n");

      if (headerEnd < 0) {
        res.writeHead(500);
        res.end("Invalid CGI response from git-http-backend");
        return;
      }

      const headerLines = output.subarray(0, headerEnd).toString("utf8").split(/\r?\n/);
      const body = output.subarray(headerEnd + sepLen);
      let statusCode = 200;
      const responseHeaders: Record<string, string> = {};

      for (const line of headerLines) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim();
        if (key.toLowerCase() === "status") {
          statusCode = Number.parseInt(val.split(" ")[0], 10) || 200;
        } else {
          responseHeaders[key] = val;
        }
      }

      res.writeHead(statusCode, responseHeaders);
      res.end(body);
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
