import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { WorkspaceTokens } from "./WorkspaceTokens.ts";

/** The port the workspace server listens on inside its container. */
export const WORKSPACE_PORT = 3773;
/** The port the control server dials; tests point it at a stand-in workspace. */
export const WorkspaceDialPort = Context.Reference<number>(
  "@codenine/control/workspaces/workspaceSpec/WorkspaceDialPort",
  { defaultValue: () => WORKSPACE_PORT },
);
/** The person's home in the container, kept on their own volume. */
export const WORKSPACE_HOME = "/home/codenine";
/** The ordinary user and group the workspace image runs as. */
export const WORKSPACE_UID = 1000;
/** Where the egress proxy listens. */
export const EGRESS_PORT = 3128;

/** Settings every workspace driver reads. */
export const WorkspaceConfig = Config.all({
  image: Config.String("CODENINE_CONTROL_WORKSPACE_IMAGE"),
  cpus: Config.Number("CODENINE_CONTROL_WORKSPACE_CPUS").pipe(Config.withDefault(2)),
  memoryGb: Config.Number("CODENINE_CONTROL_WORKSPACE_MEMORY_GB").pipe(Config.withDefault(4)),
  sleepMinutes: Config.Number("CODENINE_CONTROL_WORKSPACE_SLEEP_MINUTES").pipe(
    Config.withDefault(30),
  ),
});

/** What a managed workspace needs: whom to trust, when to sleep, how to reach out. */
export const workspaceEnv = (input: {
  readonly verifier: WorkspaceTokens["Service"]["verifier"];
  readonly personId: string;
  readonly sleepMinutes: number;
  readonly proxyUrl: string;
}) => ({
  CODENINE_MODE: "managed",
  CODENINE_MANAGED_ISSUER: input.verifier.issuer,
  CODENINE_MANAGED_KEY_ID: input.verifier.keyId,
  CODENINE_MANAGED_PUBLIC_KEY: input.verifier.publicKey,
  CODENINE_MANAGED_WORKSPACE_ID: input.personId,
  CODENINE_MANAGED_SLEEP_MINUTES: String(input.sleepMinutes),
  // Its network leads nowhere else: everything outside goes through the proxy.
  HTTP_PROXY: input.proxyUrl,
  HTTPS_PROXY: input.proxyUrl,
  http_proxy: input.proxyUrl,
  https_proxy: input.proxyUrl,
  NO_PROXY: "localhost,127.0.0.1",
  no_proxy: "localhost,127.0.0.1",
  NODE_USE_ENV_PROXY: "1",
});

/** What every workspace may reach: model providers and their sign-in, GitHub, package registries. */
export const DEFAULT_ALLOWED_HOSTS: ReadonlyArray<string> = [
  ".anthropic.com",
  ".claude.ai",
  ".claude.com",
  ".openai.com",
  ".chatgpt.com",
  ".github.com",
  ".githubusercontent.com",
  ".npmjs.org",
  ".yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  ".crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "repo.maven.apache.org",
  "repo1.maven.org",
];
/** A host name, or with a leading dot, a domain and everything under it. */
const HOST = /^\.?[a-z0-9-]+(\.[a-z0-9-]+)+$/u;

/** The default hosts and an admin's own, leaving out any that a wider entry covers. */
export const allowedHosts = (extra: ReadonlyArray<string>) => {
  const all = [...new Set([...DEFAULT_ALLOWED_HOSTS, ...extra])];
  const covers = (wide: string, host: string) =>
    wide !== host && wide.startsWith(".") && (host === wide.slice(1) || host.endsWith(wide));
  return all.filter((host) => !all.some((other) => covers(other, host)));
};

/** The hosts allowed with `CODENINE_CONTROL_WORKSPACE_ALLOWED_HOSTS`, refusing anything else. */
export const allowedHostsFromConfig = Effect.gen(function* () {
  const extra = (yield* Config.String("CODENINE_CONTROL_WORKSPACE_ALLOWED_HOSTS").pipe(
    Config.withDefault(""),
  ))
    .split(/[\s,]+/u)
    .map((host) => host.toLowerCase())
    .filter((host) => host.length > 0);
  const invalid = extra.filter((host) => !HOST.test(host));
  if (invalid.length > 0) {
    return yield* Effect.die(
      `CODENINE_CONTROL_WORKSPACE_ALLOWED_HOSTS has entries that are not host names: ${invalid.join(", ")}.`,
    );
  }
  return allowedHosts(extra);
});

/** Squid allowing only those hosts, on the usual web ports, with no cache. */
export const egressProxyConfig = (hosts: ReadonlyArray<string>) =>
  [
    `http_port ${EGRESS_PORT}`,
    "pid_filename none",
    "pinger_enable off",
    "netdb_filename none",
    "cache deny all",
    "coredump_dir /tmp",
    "access_log stdio:/dev/stdout",
    "cache_log /dev/stderr",
    // -n matches names only, so a request for a bare address never matches.
    `acl allowed dstdomain -n ${hosts.join(" ")}`,
    "acl SSL_ports port 443",
    "acl Safe_ports port 80 443",
    "acl CONNECT method CONNECT",
    "http_access deny !Safe_ports",
    "http_access deny CONNECT !SSL_ports",
    "http_access allow allowed",
    "http_access deny all",
  ].join("\n");
