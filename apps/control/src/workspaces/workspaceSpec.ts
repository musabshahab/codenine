import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { coversHost } from "../profiles/layering.ts";
import { type WorkspaceKey, workspaceIdOf } from "./WorkspaceManager.ts";
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
/**
 * Workspaces reach the AI gateway at this name and port: on Docker the egress
 * proxy answers to it on each workspace's network, on Kubernetes a service.
 */
export const GATEWAY_ALIAS = "codenine-gateway";
export const GATEWAY_PORT = 8080;
export const GATEWAY_URL = `http://${GATEWAY_ALIAS}:${GATEWAY_PORT}`;

const sizeConfig = {
  cpus: Config.Number("CODENINE_CONTROL_WORKSPACE_CPUS").pipe(Config.withDefault(2)),
  memoryGb: Config.Number("CODENINE_CONTROL_WORKSPACE_MEMORY_GB").pipe(Config.withDefault(4)),
  sleepMinutes: Config.Number("CODENINE_CONTROL_WORKSPACE_SLEEP_MINUTES").pipe(
    Config.withDefault(30),
  ),
};

/** The size workspaces get where no profile sets one. */
export const WorkspaceSizeConfig = Config.all(sizeConfig);

/** Settings every workspace driver reads. */
export const WorkspaceConfig = Config.all({
  image: Config.String("CODENINE_CONTROL_WORKSPACE_IMAGE"),
  ...sizeConfig,
});

const NO_PROXY = `localhost,127.0.0.1,${GATEWAY_ALIAS}`;

/** Codex's provider: the gateway's Responses API, with the token from the environment. */
const CODEX_LAUNCH_ARGS = [
  'model_provider="codenine"',
  // Codex keeps this provider ID in its sessions and needs it unchanged to resume them.
  `model_providers.codenine={name="Company account",base_url="${GATEWAY_URL}/openai/v1",wire_api="responses",env_key="CODENINE_MANAGED_AI_TOKEN",requires_openai_auth=false,supports_websockets=false}`,
]
  .map((value) => `-c ${JSON.stringify(value)}`)
  .join(" ");

/** What a managed workspace needs: whom to trust, when to sleep, how to reach out. */
export const workspaceEnv = (input: {
  readonly verifier: WorkspaceTokens["Service"]["verifier"];
  readonly workspaceId: string;
  readonly sleepMinutes: number;
  readonly proxyUrl: string;
  readonly gatewayToken: string;
}) => ({
  CODENINE_MODE: "managed",
  CODENINE_MANAGED_ISSUER: input.verifier.issuer,
  CODENINE_MANAGED_KEY_ID: input.verifier.keyId,
  CODENINE_MANAGED_PUBLIC_KEY: input.verifier.publicKey,
  CODENINE_MANAGED_WORKSPACE_ID: input.workspaceId,
  CODENINE_MANAGED_SLEEP_MINUTES: String(input.sleepMinutes),
  // Its network leads nowhere else: everything outside goes through the proxy.
  HTTP_PROXY: input.proxyUrl,
  HTTPS_PROXY: input.proxyUrl,
  http_proxy: input.proxyUrl,
  https_proxy: input.proxyUrl,
  NO_PROXY,
  no_proxy: NO_PROXY,
  NODE_USE_ENV_PROXY: "1",
  // Claude and Codex, in the app and in a terminal alike, go through the company's gateway.
  CODENINE_MANAGED_AI_GATEWAY: GATEWAY_URL,
  CODENINE_MANAGED_AI_TOKEN: input.gatewayToken,
  ANTHROPIC_BASE_URL: `${GATEWAY_URL}/anthropic`,
  ANTHROPIC_AUTH_TOKEN: input.gatewayToken,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CODENINE_CODEX_LAUNCH_ARGS: CODEX_LAUNCH_ARGS,
  OPENAI_BASE_URL: `${GATEWAY_URL}/openai/v1`,
  OPENAI_API_KEY: input.gatewayToken,
});

/** The labels marking whose workspace a container, pod, volume or network is. */
export const workspaceLabels = (installationId: string, key: WorkspaceKey) => ({
  "codenine.installation": installationId,
  "codenine.person": key.personId,
  "codenine.workspace": workspaceIdOf(key),
  ...(key.departmentId === null ? {} : { "codenine.department": key.departmentId }),
});

/**
 * What every workspace may reach: GitHub and package registries. Claude and
 * Codex go through the gateway, never straight to Anthropic or OpenAI.
 */
export const DEFAULT_ALLOWED_HOSTS: ReadonlyArray<string> = [
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

/** Without any a wider entry covers, as Squid wants its lists. */
const withoutCovered = (hosts: ReadonlyArray<string>) => {
  const all = [...new Set(hosts)];
  return all.filter((host) => !all.some((other) => other !== host && coversHost(other, host)));
};

/** The default hosts and an admin's own, leaving out any that a wider entry covers. */
export const allowedHosts = (extra: ReadonlyArray<string>) =>
  withoutCovered([...DEFAULT_ALLOWED_HOSTS, ...extra]);

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

/**
 * What a workspace may reach: the installation's hosts and its profile's, less
 * those its profile blocks. A blocked host under an allowed domain stays on the
 * deny list, which the proxy checks first.
 */
export const egressHosts = (
  installationHosts: ReadonlyArray<string>,
  profile: {
    readonly allowHosts: ReadonlyArray<string>;
    readonly blockHosts: ReadonlyArray<string>;
  },
) => {
  // Checked when saved, and again here: each one becomes part of the proxy's settings.
  const valid = (hosts: ReadonlyArray<string>) => hosts.filter((host) => HOST.test(host));
  const blocked = withoutCovered(valid(profile.blockHosts));
  return {
    allowed: allowedHosts([...installationHosts, ...valid(profile.allowHosts)]).filter(
      (host) => !blocked.some((wide) => coversHost(wide, host)),
    ),
    blocked,
  };
};

/** Where the egress proxies reach the AI gateway, from `CODENINE_CONTROL_GATEWAY_UPSTREAM`. */
export const GatewayUpstreamConfig = Effect.gen(function* () {
  const port = yield* Config.Port("CODENINE_CONTROL_GATEWAY_PORT").pipe(Config.withDefault(3781));
  const raw = yield* Config.String("CODENINE_CONTROL_GATEWAY_UPSTREAM").pipe(
    Config.withDefault(`host.docker.internal:${port}`),
  );
  const match = /^([a-z0-9.-]+):(\d{1,5})$/iu.exec(raw.trim());
  if (match === null) {
    return yield* Effect.die(
      "CODENINE_CONTROL_GATEWAY_UPSTREAM must be a host and port, such as codenine-control:3781.",
    );
  }
  return { host: match[1] ?? "", port: Number(match[2]) };
});

/**
 * Squid allowing only those hosts and none of `blocked`, on the usual web
 * ports, with no cache. With a gateway, it also answers to the gateway's name
 * and passes those requests to the control server as they are.
 */
export const egressProxyConfig = (
  hosts: ReadonlyArray<string>,
  blocked: ReadonlyArray<string> = [],
  gateway?: { readonly host: string; readonly port: number },
) =>
  [
    `http_port ${EGRESS_PORT}`,
    ...(gateway === undefined
      ? []
      : [
          `http_port ${GATEWAY_PORT} accel defaultsite=${GATEWAY_ALIAS} name=gateway`,
          `cache_peer ${gateway.host} parent ${gateway.port} 0 no-query originserver login=PASSTHRU name=control`,
          "acl to_gateway myportname gateway",
          "cache_peer_access control allow to_gateway",
          "cache_peer_access control deny all",
          "never_direct allow to_gateway",
        ]),
    "pid_filename none",
    "pinger_enable off",
    "netdb_filename none",
    "cache deny all",
    "coredump_dir /tmp",
    "access_log stdio:/dev/stdout",
    "cache_log /dev/stderr",
    // -n matches names only, so a request for a bare address never matches.
    ...(hosts.length === 0 ? [] : [`acl allowed dstdomain -n ${hosts.join(" ")}`]),
    ...(blocked.length === 0 ? [] : [`acl blocked dstdomain -n ${blocked.join(" ")}`]),
    "acl SSL_ports port 443",
    "acl Safe_ports port 80 443",
    "acl CONNECT method CONNECT",
    ...(gateway === undefined ? [] : ["http_access allow to_gateway"]),
    "http_access deny !Safe_ports",
    "http_access deny CONNECT !SSL_ports",
    ...(blocked.length === 0 ? [] : ["http_access deny blocked"]),
    ...(hosts.length === 0 ? [] : ["http_access allow allowed"]),
    "http_access deny all",
  ].join("\n");
