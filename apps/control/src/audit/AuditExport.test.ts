// @effect-diagnostics nodeBuiltinImport:off - local syslog and collector servers to send to.
import * as NodeDgram from "node:dgram";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ControlAuditEntry } from "@codenine/contracts/control";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { Installation } from "../installation/Installation.ts";
import { layerTestServices } from "../testing/layerTestServices.ts";
import { testKeyPair } from "../testing/testLicence.ts";
import {
  AuditExportError,
  type AuditSink,
  makeKeeper,
  makeOtlpSink,
  makeSyslogSink,
} from "./AuditExport.ts";
import { AuditLog, ON_THE_SERVER } from "./AuditLog.ts";
import { octetCounted, otlpLogs, syslogMessage } from "./auditFormats.ts";

const entry = (id: number, label = "ada@acme.test"): ControlAuditEntry => ({
  id,
  at: "2026-12-10T12:00:00.000Z",
  actor: { kind: "person", id: "per_ada", label },
  action: "person.role",
  target: { kind: "person", id: "per_cy", label: "cy@acme.test" },
  source: { address: "198.51.100.23", userAgent: "Firefox" },
  before: { role: "member" },
  after: { role: "admin" },
});

const PREFIX =
  "<109>1 2026-12-10T12:00:00.000Z codenine.acme.test codenine-control - person.role - ";

describe("audit formats", () => {
  it("writes RFC 5424 messages whose text is the entry, framed by their length in bytes", () => {
    const message = syslogMessage(entry(7, "zoë@acme.test"), "codenine.acme.test");
    expect(message.startsWith(PREFIX)).toBe(true);
    expect(JSON.parse(message.slice(PREFIX.length))).toEqual(entry(7, "zoë@acme.test"));
    expect(octetCounted("zoë")).toBe("4 zoë");
  });

  it("writes one OTLP log record per entry, with integers as strings and no empty attributes", () => {
    const signIn: ControlAuditEntry = {
      ...entry(8),
      action: "person.sign-in",
      target: null,
      before: null,
    };
    const [record] =
      otlpLogs([signIn], { installationId: "inst_1" }).resourceLogs[0]?.scopeLogs[0]?.logRecords ??
      [];
    expect(record).toMatchObject({
      timeUnixNano: "1796904000000000000",
      body: { stringValue: "ada@acme.test person.sign-in" },
    });
    expect(record?.attributes).toEqual([
      { key: "codenine.audit.id", value: { intValue: "8" } },
      { key: "codenine.audit.action", value: { stringValue: "person.sign-in" } },
      { key: "codenine.audit.actor.kind", value: { stringValue: "person" } },
      { key: "codenine.audit.actor.id", value: { stringValue: "per_ada" } },
      { key: "codenine.audit.actor.label", value: { stringValue: "ada@acme.test" } },
      { key: "client.address", value: { stringValue: "198.51.100.23" } },
      { key: "user_agent.original", value: { stringValue: "Firefox" } },
      { key: "codenine.audit.after", value: { stringValue: '{"role":"admin"}' } },
    ]);
  });
});

const withAuditLog = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const keys = yield* testKeyPair;
    yield* TestClock.setTime(Date.parse("2026-12-10T12:00:00Z"));
    return yield* body.pipe(Effect.provide(layerTestServices(keys.publicKey)));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

describe("AuditExport", () => {
  it.effect("sends each entry at least once, and removes old entries only once sent", () =>
    withAuditLog(
      Effect.gen(function* () {
        const auditLog = yield* AuditLog;
        const record = (label: string) =>
          auditLog.record({
            actor: { kind: "person", id: null, label },
            source: ON_THE_SERVER,
            action: "person.sign-in",
            target: null,
            before: null,
            after: null,
          });
        const remaining = auditLog
          .list(null)
          .pipe(Effect.map(({ entries }) => entries.map(({ actor }) => actor.label).toReversed()));
        const received: Array<string> = [];
        let down = false;
        const sink: AuditSink = {
          name: "syslog",
          send: (entries) =>
            down
              ? Effect.fail(new AuditExportError({ sink: "syslog", cause: "down" }))
              : Effect.sync(() => void received.push(...entries.map(({ actor }) => actor.label))),
        };
        const keeper = yield* makeKeeper({ sinks: [sink], retentionDays: 30 });

        yield* record("a");
        yield* record("b");
        yield* keeper.drain(sink);
        expect(received).toEqual(["a", "b"]);

        // While the sink is down, c waits for it: it is neither lost nor removed.
        yield* record("c");
        down = true;
        expect((yield* Effect.flip(keeper.drain(sink)))._tag).toBe("AuditExportError");
        yield* TestClock.adjust("31 days");
        yield* keeper.sweep;
        expect(yield* remaining).toEqual(["c"]);

        down = false;
        yield* keeper.drain(sink);
        expect(received).toEqual(["a", "b", "c"]);
        yield* keeper.sweep;
        expect(yield* remaining).toEqual([]);
      }),
    ),
  );

  it.live("sends syslog over TCP with octet counting, and over UDP", () =>
    Effect.gen(function* () {
      const tcp = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<{ server: NodeNet.Server; port: number; data: Promise<string> }>(
              (resolve) => {
                let deliver = (_data: string) => {};
                const data = new Promise<string>((done) => {
                  deliver = done;
                });
                const server = NodeNet.createServer((socket) => {
                  const chunks: Array<Buffer> = [];
                  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
                  socket.on("end", () => deliver(Buffer.concat(chunks).toString()));
                });
                server.listen(0, "127.0.0.1", () =>
                  resolve({ server, port: (server.address() as NodeNet.AddressInfo).port, data }),
                );
              },
            ),
        ),
        ({ server }) => Effect.sync(() => server.close()),
      );
      const udp = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<{ socket: NodeDgram.Socket; port: number; data: Promise<Array<string>> }>(
              (resolve) => {
                const messages: Array<string> = [];
                let deliver = (_data: Array<string>) => {};
                const data = new Promise<Array<string>>((done) => {
                  deliver = done;
                });
                const socket = NodeDgram.createSocket("udp4");
                socket.on("message", (message: Buffer) => {
                  messages.push(message.toString());
                  if (messages.length === 2) deliver(messages);
                });
                socket.bind(0, "127.0.0.1", () =>
                  resolve({ socket, port: socket.address().port, data }),
                );
              },
            ),
        ),
        ({ socket }) => Effect.sync(() => socket.close()),
      );
      const entries = [entry(1), entry(2)];
      const messages = entries.map((one) => syslogMessage(one, "codenine.acme.test"));

      yield* (yield* makeSyslogSink(`tcp://127.0.0.1:${tcp.port}`, "codenine.acme.test")).send(
        entries,
      );
      expect(yield* Effect.promise(() => tcp.data)).toBe(messages.map(octetCounted).join(""));

      yield* (yield* makeSyslogSink(`udp://127.0.0.1:${udp.port}`, "codenine.acme.test")).send(
        entries,
      );
      expect(yield* Effect.promise(() => udp.data)).toEqual(messages);
    }).pipe(Effect.scoped),
  );

  it.live("posts OTLP logs with the configured headers, and fails on an error status", () =>
    Effect.gen(function* () {
      const requests: Array<{ url: string; headers: NodeHttp.IncomingHttpHeaders; body: string }> =
        [];
      let status = 200;
      const port = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<{ server: NodeHttp.Server; port: number }>((resolve) => {
              const server = NodeHttp.createServer((request, response) => {
                const chunks: Array<Buffer> = [];
                request.on("data", (chunk: Buffer) => chunks.push(chunk));
                request.on("end", () => {
                  requests.push({
                    url: request.url ?? "",
                    headers: request.headers,
                    body: Buffer.concat(chunks).toString(),
                  });
                  response.writeHead(status).end();
                });
              });
              server.listen(0, "127.0.0.1", () =>
                resolve({ server, port: (server.address() as NodeNet.AddressInfo).port }),
              );
            }),
        ),
        ({ server }) => Effect.sync(() => server.close()),
      ).pipe(Effect.map(({ port }) => port));
      const sink = yield* makeOtlpSink(`http://127.0.0.1:${port}/v1/logs`, {
        authorization: "Bearer collector-token",
      });

      yield* sink.send([entry(3)]);
      expect(requests[0]).toMatchObject({
        url: "/v1/logs",
        headers: { authorization: "Bearer collector-token", "content-type": "application/json" },
      });
      expect(JSON.parse(requests[0]?.body ?? "")).toEqual(
        otlpLogs([entry(3)], { installationId: "inst_test" }),
      );

      status = 503;
      expect((yield* Effect.flip(sink.send([entry(4)])))._tag).toBe("AuditExportError");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeHttpClient.layerUndici,
          Layer.succeed(Installation, Installation.of({ id: "inst_test" })),
        ),
      ),
    ),
  );
});
