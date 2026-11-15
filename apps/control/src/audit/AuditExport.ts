// @effect-diagnostics nodeBuiltinImport:off - syslog travels over plain UDP, TCP and TLS sockets.
import * as NodeDgram from "node:dgram";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";

import type { ControlAuditEntry } from "@codenine/contracts/control";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { eq, inArray } from "drizzle-orm";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { ControlPublicUrl } from "../config.ts";
import { ControlDb } from "../db.ts";
import { Installation } from "../installation/Installation.ts";
import { controlAuditExports } from "../persistence/schema.ts";
import { AuditLog } from "./AuditLog.ts";
import { octetCounted, otlpLogs, syslogMessage } from "./auditFormats.ts";

const BATCH = 100;

export class AuditExportError extends Schema.TaggedError<AuditExportError>()("AuditExportError", {
  sink: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Somewhere outside Codenine that keeps a copy of the audit log. */
export interface AuditSink {
  readonly name: "syslog" | "otlp";
  readonly send: (
    entries: ReadonlyArray<ControlAuditEntry>,
  ) => Effect.Effect<void, AuditExportError>;
}

const deliverSyslog =
  (
    target: {
      readonly transport: "udp" | "tcp" | "tls";
      readonly host: string;
      readonly port: number;
    },
    messages: ReadonlyArray<string>,
  ) =>
  (signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (target.transport === "udp") {
        const socket = NodeDgram.createSocket(NodeNet.isIPv6(target.host) ? "udp6" : "udp4");
        let open = true;
        const close = () => {
          if (open) socket.close();
          open = false;
        };
        signal.addEventListener("abort", close, { once: true });
        socket.once("error", (error) => {
          close();
          reject(error);
        });
        const sendFrom = (index: number) => {
          const message = messages[index];
          if (message === undefined) {
            close();
            resolve();
            return;
          }
          socket.send(message, target.port, target.host, (error) => {
            if (error) {
              close();
              reject(error);
            } else {
              sendFrom(index + 1);
            }
          });
        };
        sendFrom(0);
        return;
      }
      const socket =
        target.transport === "tls"
          ? NodeTls.connect({
              host: target.host,
              port: target.port,
              ...(NodeNet.isIP(target.host) === 0 ? { servername: target.host } : {}),
            })
          : NodeNet.connect({ host: target.host, port: target.port });
      signal.addEventListener("abort", () => socket.destroy(), { once: true });
      socket.once("error", reject);
      socket.end(messages.map(octetCounted).join(""), () => resolve());
    });

/** `udp://host:514`, `tcp://host:514` or `tls://host:6514`, sending RFC 5424 messages. */
export const makeSyslogSink = (raw: string, hostname: string) => {
  const url = URL.parse(raw.trim());
  const transport = url?.protocol.slice(0, -1);
  if (url === null || (transport !== "udp" && transport !== "tcp" && transport !== "tls")) {
    return Effect.die(
      "CODENINE_CONTROL_AUDIT_SYSLOG must look like udp://host:514, tcp://host:514 or tls://host:6514.",
    );
  }
  const target = {
    transport,
    host: url.hostname.replace(/^\[|\]$/gu, ""),
    port: Number(url.port || (transport === "tls" ? 6514 : 514)),
  } as const;
  return Effect.succeed<AuditSink>({
    name: "syslog",
    send: (entries) =>
      Effect.tryPromise({
        try: deliverSyslog(
          target,
          entries.map((entry) => syslogMessage(entry, hostname)),
        ),
        catch: (cause) => new AuditExportError({ sink: "syslog", cause }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () =>
            Effect.fail(
              new AuditExportError({ sink: "syslog", cause: "No answer in 15 seconds." }),
            ),
        }),
      ),
  });
};

/** `key=value,key=value`, as OpenTelemetry's own header settings are written. */
const parseHeaders = (raw: string) =>
  Object.fromEntries(
    raw
      .split(",")
      .map((pair) => pair.split("="))
      .flatMap(([key, ...value]) =>
        key === undefined || key.trim() === "" ? [] : [[key.trim(), value.join("=").trim()]],
      ),
  );

/** An OTLP/HTTP logs endpoint, such as `https://collector:4318/v1/logs`. */
export const makeOtlpSink = Effect.fn("AuditExport.makeOtlpSink")(function* (
  url: string,
  headers: Readonly<Record<string, string>>,
) {
  if (!URL.canParse(url) || !/^https?:$/u.test(new URL(url).protocol)) {
    return yield* Effect.die(
      "CODENINE_CONTROL_AUDIT_OTLP_URL must be an http or https address, such as https://collector:4318/v1/logs.",
    );
  }
  const client = yield* HttpClient.HttpClient;
  const { id: installationId } = yield* Installation;
  return {
    name: "otlp",
    send: (entries) =>
      client
        .execute(
          HttpClientRequest.post(url).pipe(
            HttpClientRequest.setHeaders(headers),
            HttpClientRequest.bodyJsonUnsafe(otlpLogs(entries, { installationId })),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.timeout("15 seconds"),
          Effect.mapError((cause) => new AuditExportError({ sink: "otlp", cause })),
          Effect.asVoid,
        ),
  } satisfies AuditSink;
});

const dieOnDatabaseError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catchTags({ EffectDrizzleQueryError: Effect.die, SqlError: Effect.die }));

/**
 * Sends new entries to each sink, at least once: a sink's cursor moves only
 * after it accepted a batch, so a failure resends rather than skips. Entries
 * past retention are removed only once every sink has them.
 */
export const makeKeeper = Effect.fn("AuditExport.makeKeeper")(function* (input: {
  readonly sinks: ReadonlyArray<AuditSink>;
  /** Zero keeps entries for good. */
  readonly retentionDays: number;
}) {
  const db = yield* ControlDb;
  const auditLog = yield* AuditLog;
  for (const sink of input.sinks) {
    yield* db
      .insert(controlAuditExports)
      .values({ sink: sink.name, lastId: 0 })
      .onConflictDoNothing();
  }

  /** How many it sent; none while another control server holds this sink's cursor. */
  const exportBatch = Effect.fn("AuditExport.exportBatch")(function* (sink: AuditSink) {
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const [cursor] = yield* db
          .select({ lastId: controlAuditExports.lastId })
          .from(controlAuditExports)
          .where(eq(controlAuditExports.sink, sink.name))
          .for("update", { skipLocked: true });
        if (cursor === undefined) return 0;
        const entries = yield* auditLog.after(cursor.lastId, BATCH);
        const last = entries.at(-1);
        if (last === undefined) return 0;
        yield* sink.send(entries);
        yield* db
          .update(controlAuditExports)
          .set({ lastId: last.id })
          .where(eq(controlAuditExports.sink, sink.name));
        return entries.length;
      }),
    );
  }, dieOnDatabaseError);

  const sweep = Effect.gen(function* () {
    if (input.retentionDays === 0) return;
    const before = DateTime.formatIso(
      DateTime.subtract(yield* DateTime.now, { days: input.retentionDays }),
    );
    const names = input.sinks.map((sink) => sink.name);
    const cursors =
      names.length === 0
        ? []
        : yield* db
            .select({ lastId: controlAuditExports.lastId })
            .from(controlAuditExports)
            .where(inArray(controlAuditExports.sink, names));
    const upTo =
      names.length === 0
        ? null
        : cursors.length < names.length
          ? 0
          : Math.min(...cursors.map((cursor) => cursor.lastId));
    yield* auditLog.remove({ before, upTo });
  }).pipe(dieOnDatabaseError, Effect.withSpan("AuditExport.sweep"));

  return {
    /** Sends batches until the sink has everything. */
    drain: (sink: AuditSink) =>
      exportBatch(sink).pipe(Effect.repeat({ while: (sent) => sent === BATCH })),
    sweep,
  };
});

const AuditExportConfig = Config.all({
  syslog: Config.option(Config.String("CODENINE_CONTROL_AUDIT_SYSLOG")),
  otlpUrl: Config.option(Config.String("CODENINE_CONTROL_AUDIT_OTLP_URL")),
  otlpHeaders: Config.option(Config.Redacted("CODENINE_CONTROL_AUDIT_OTLP_HEADERS")),
  retentionDays: Config.Number("CODENINE_CONTROL_AUDIT_RETENTION_DAYS").pipe(
    Config.withDefault(365),
  ),
});

/** Sends the audit log to the configured sinks every few seconds, and prunes it hourly. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* AuditExportConfig;
    if (!Number.isInteger(settings.retentionDays) || settings.retentionDays < 0) {
      return yield* Effect.die(
        "CODENINE_CONTROL_AUDIT_RETENTION_DAYS must be a whole number of days, or 0 to keep entries for good.",
      );
    }
    const { origin } = yield* ControlPublicUrl;
    const sinks: Array<AuditSink> = [];
    if (Option.isSome(settings.syslog)) {
      sinks.push(yield* makeSyslogSink(settings.syslog.value, new URL(origin).hostname));
    }
    if (Option.isSome(settings.otlpUrl)) {
      const headers = Option.match(settings.otlpHeaders, {
        onNone: () => ({}),
        onSome: (raw) => parseHeaders(Redacted.value(raw)),
      });
      sinks.push(yield* makeOtlpSink(settings.otlpUrl.value, headers));
    }
    const keeper = yield* makeKeeper({ sinks, retentionDays: settings.retentionDays });

    for (const sink of sinks) {
      // Log when a sink stops answering and when it is back, not on every retry.
      const answering = yield* Ref.make(true);
      yield* keeper.drain(sink).pipe(
        Effect.flatMap(() => Ref.getAndSet(answering, true)),
        Effect.flatMap((was) =>
          was ? Effect.void : Effect.logInfo(`The audit log reaches ${sink.name} again.`),
        ),
        Effect.catchCause((cause) =>
          Ref.getAndSet(answering, false).pipe(
            Effect.flatMap((was) =>
              was
                ? Effect.logWarning(
                    `Could not send the audit log to ${sink.name}. Retrying every 5 seconds.`,
                    cause,
                  )
                : Effect.void,
            ),
          ),
        ),
        Effect.repeat(Schedule.spaced("5 seconds")),
        Effect.forkScoped,
      );
    }
    yield* keeper.sweep.pipe(
      Effect.catchCause((cause) => Effect.logError("The audit log retention sweep failed.", cause)),
      Effect.repeat(Schedule.spaced("1 hour")),
      Effect.forkScoped,
    );
  }),
).pipe(Layer.provide(NodeHttpClient.layerUndici));
