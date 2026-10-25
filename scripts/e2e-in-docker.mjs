// Runs INSIDE the Playwright image (scripts/e2e-visual-docker.mjs puts it first in the container's command): forwards the container's own
// loopback ports to the host, then runs the command that follows `--` and ends with its exit code.
//
//   node scripts/e2e-in-docker.mjs --forward 27209,22222 --target host.docker.internal -- node scripts/e2e-phases.mjs visual
//
// `127.0.0.1:<port>` of the container becomes `host.docker.internal:<port>` for each port, so the app and the database the release runner
// started on the host's loopback are where the browser run's environment says they are. Plain `node:net`, no dependency: the image has
// Node and nothing else to forward with. Unit tested in tests/unit/scripts/e2e-in-docker.test.ts.

import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * A TCP forwarder: every connection to `listenHost:listenPort` is piped to `targetHost:targetPort`, in both directions. A connection that
 * fails on either side ends the other side too (nothing is left half open).
 *
 * @param {{ listenPort: number, targetHost: string, targetPort?: number, listenHost?: string }} options `listenPort: 0` takes a free port
 * @returns {Promise<net.Server & { port: number }>} listening
 */
export function startForwarder({ listenPort, targetHost, targetPort = listenPort, listenHost = "127.0.0.1" }) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      const upstream = net.connect({ host: targetHost, port: targetPort });
      const end = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on("error", end);
      upstream.on("error", end);
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    });
    server.once("error", reject);
    server.listen(listenPort, listenHost, () => {
      const address = /** @type {net.AddressInfo} */ (server.address());
      resolve(Object.assign(server, { port: address.port }));
    });
  });
}

/**
 * @param {string[]} argv the arguments after the script name
 * @returns {{ ports: number[], target: string, command: string[] }}
 */
export function parseInDockerArgs(argv) {
  const separator = argv.indexOf("--");
  if (separator === -1 || separator === argv.length - 1) throw new Error("usage: e2e-in-docker.mjs [--forward <port,port>] [--target <host>] -- <command...>");
  const own = argv.slice(0, separator);
  const command = argv.slice(separator + 1);
  let ports = [];
  let target = "host.docker.internal";
  for (let i = 0; i < own.length; i += 1) {
    if (own[i] === "--forward") {
      const list = own[(i += 1)] ?? "";
      ports = list.split(",").filter(Boolean).map(Number);
      if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error(`--forward needs ports (1-65535), got "${list}"`);
    } else if (own[i] === "--target") {
      target = own[(i += 1)] ?? "";
      if (!target) throw new Error("--target needs a host name");
    } else throw new Error(`unknown option ${own[i]}`);
  }
  return { ports, target, command };
}

async function main() {
  const { ports, target, command } = parseInDockerArgs(process.argv.slice(2));
  const forwarders = await Promise.all(ports.map((port) => startForwarder({ listenPort: port, targetHost: target })));
  const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(`[e2e-in-docker] could not start ${command[0]}: ${error.message}`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    for (const forwarder of forwarders) forwarder.close();
    process.exit(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`[e2e-in-docker] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  });
}
