// JetKVM touch proxy.
// Serves the JetKVM web UI from your device through this proxy, and adds a
// script to every HTML page that turns iPhone/iPad touch gestures into the
// mouse events the JetKVM UI already understands. No device changes needed.
//
// Only Node's standard library is used, so the image has no npm dependencies.

"use strict";

const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const fs = require("fs");
const path = require("path");

const TARGET_RAW = process.env.JETKVM_URL || process.env.JETKVM_HOST || "";
const PORT = parseInt(process.env.PORT || "8080", 10);
const INSECURE_TLS = (process.env.JETKVM_INSECURE_TLS || "true") === "true";
const SCRIPT_PATH = "/__touch/touch.js";

if (!TARGET_RAW) {
  console.error("Set JETKVM_URL to your device, for example JETKVM_URL=http://192.168.1.50");
  process.exit(1);
}

const target = new URL(/^https?:\/\//.test(TARGET_RAW) ? TARGET_RAW : `http://${TARGET_RAW}`);
const targetIsHttps = target.protocol === "https:";
const targetPort = target.port ? parseInt(target.port, 10) : targetIsHttps ? 443 : 80;
// The device compares the Host header to its own IPs when it picks the
// address to advertise for WebRTC, so we always present the device's own host.
const targetHostHeader = target.host;
const client = targetIsHttps ? https : http;

const touchScript = fs.readFileSync(path.join(__dirname, "touch.js"));
// The meta tags let "Add to Home Screen" on iPhone open the page full screen,
// without Safari's address bar.
const scriptTag =
  `<meta name="apple-mobile-web-app-capable" content="yes">` +
  `<meta name="mobile-web-app-capable" content="yes">` +
  `<meta name="apple-mobile-web-app-status-bar-style" content="black">` +
  `<script src="${SCRIPT_PATH}"></script>`;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function upstreamHeaders(req) {
  const headers = { ...req.headers };
  headers.host = targetHostHeader;
  // Ask for uncompressed responses so HTML can be edited without unzipping.
  headers["accept-encoding"] = "identity";
  if (headers.origin) headers.origin = `${target.protocol}//${targetHostHeader}`;
  if (headers.referer) {
    try {
      const r = new URL(headers.referer);
      headers.referer = `${target.protocol}//${targetHostHeader}${r.pathname}${r.search}`;
    } catch {
      delete headers.referer;
    }
  }
  return headers;
}

function injectScript(html) {
  if (html.includes(SCRIPT_PATH)) return html;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${scriptTag}</head>`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, m => `${m}${scriptTag}`);
  return scriptTag + html;
}

const server = http.createServer((req, res) => {
  if (req.url === SCRIPT_PATH || req.url.startsWith(`${SCRIPT_PATH}?`)) {
    res.writeHead(200, {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-cache",
    });
    res.end(touchScript);
    return;
  }
  if (req.url === "/__touch/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  const upstreamReq = client.request(
    {
      hostname: target.hostname,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req),
      rejectUnauthorized: !INSECURE_TLS,
    },
    upstreamRes => {
      const headers = { ...upstreamRes.headers };
      // Redirects to the device's own address must stay on the proxy.
      if (headers.location) {
        try {
          const loc = new URL(headers.location, `${target.protocol}//${targetHostHeader}`);
          if (loc.host === targetHostHeader) headers.location = `${loc.pathname}${loc.search}${loc.hash}`;
        } catch {
          /* leave as is */
        }
      }
      // Cookies the device sets must also work when the proxy runs over plain HTTP.
      if (headers["set-cookie"] && targetIsHttps) {
        headers["set-cookie"] = headers["set-cookie"].map(c => c.replace(/;\s*Secure/gi, ""));
      }

      const type = String(headers["content-type"] || "");
      if (type.includes("text/html")) {
        const chunks = [];
        upstreamRes.on("data", c => chunks.push(c));
        upstreamRes.on("end", () => {
          const body = Buffer.from(injectScript(Buffer.concat(chunks).toString("utf8")), "utf8");
          delete headers["content-length"];
          delete headers["content-encoding"];
          delete headers["transfer-encoding"];
          delete headers["etag"];
          headers["content-length"] = String(body.length);
          headers["cache-control"] = "no-cache";
          res.writeHead(upstreamRes.statusCode || 200, headers);
          res.end(body);
        });
        upstreamRes.on("error", () => res.destroy());
      } else {
        res.writeHead(upstreamRes.statusCode || 502, headers);
        upstreamRes.pipe(res);
      }
    },
  );

  upstreamReq.on("error", err => {
    log("upstream error", req.method, req.url, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`Could not reach the JetKVM at ${target.href}: ${err.message}\n`);
    } else {
      res.destroy();
    }
  });
  req.pipe(upstreamReq);
});

// WebSockets (the WebRTC signaling channel) are piped straight through.
server.on("upgrade", (req, socket, head) => {
  const connect = targetIsHttps
    ? cb => tls.connect({ host: target.hostname, port: targetPort, servername: target.hostname, rejectUnauthorized: !INSECURE_TLS }, cb)
    : cb => net.connect({ host: target.hostname, port: targetPort }, cb);

  const upstream = connect(() => {
    const headers = upstreamHeaders(req);
    delete headers["accept-encoding"];
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      for (const val of Array.isArray(v) ? v : [v]) raw += `${k}: ${val}\r\n`;
    }
    raw += "\r\n";
    upstream.write(raw);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on("error", err => {
    log("websocket upstream error", req.url, err.message);
    close();
  });
  socket.on("error", close);
  upstream.on("close", close);
  socket.on("close", close);
});

server.listen(PORT, () => {
  log(`JetKVM touch proxy listening on :${PORT}, forwarding to ${target.href}`);
});
