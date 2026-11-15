import { ControlAuditEntry, ControlAuditValues } from "@codenine/contracts/control";
import * as Schema from "effect/Schema";

const encodeEntry = Schema.encodeSync(Schema.fromJsonString(ControlAuditEntry));
const encodeValues = Schema.encodeSync(Schema.fromJsonString(ControlAuditValues));
const encoder = new TextEncoder();

/** Facility 13 (log audit), severity 5 (notice). */
const SYSLOG_PRIORITY = 13 * 8 + 5;

/** An RFC 5424 message whose text is the entry as JSON. */
export const syslogMessage = (entry: ControlAuditEntry, hostname: string) =>
  `<${SYSLOG_PRIORITY}>1 ${entry.at} ${hostname} codenine-control - ${entry.action} - ${encodeEntry(entry)}`;

/** RFC 6587 octet counting, the framing syslog receivers expect over TCP and TLS. */
export const octetCounted = (message: string) => `${encoder.encode(message).length} ${message}`;

type OtlpValue = { readonly stringValue: string } | { readonly intValue: string };

const attributes = (values: Record<string, string | number | null>) =>
  Object.entries(values).flatMap(([key, value]): Array<{ key: string; value: OtlpValue }> =>
    value === null
      ? []
      : [
          {
            key,
            value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value },
          },
        ],
  );

/** An OTLP/HTTP JSON logs request, one log record per entry. */
export const otlpLogs = (
  entries: ReadonlyArray<ControlAuditEntry>,
  resource: { readonly installationId: string },
) => ({
  resourceLogs: [
    {
      resource: {
        attributes: attributes({
          "service.name": "codenine-control",
          "codenine.installation.id": resource.installationId,
        }),
      },
      scopeLogs: [
        {
          scope: { name: "codenine.audit" },
          logRecords: entries.map((entry) => ({
            timeUnixNano: `${Date.parse(entry.at)}000000`,
            severityNumber: 9,
            severityText: "INFO",
            body: {
              stringValue: [entry.actor.label, entry.action, entry.target?.label]
                .filter((part) => part !== undefined)
                .join(" "),
            },
            attributes: attributes({
              "codenine.audit.id": entry.id,
              "codenine.audit.action": entry.action,
              "codenine.audit.actor.kind": entry.actor.kind,
              "codenine.audit.actor.id": entry.actor.id,
              "codenine.audit.actor.label": entry.actor.label,
              "codenine.audit.target.kind": entry.target?.kind ?? null,
              "codenine.audit.target.id": entry.target?.id ?? null,
              "codenine.audit.target.label": entry.target?.label ?? null,
              "client.address": entry.source.address,
              "user_agent.original": entry.source.userAgent,
              "codenine.audit.before": entry.before === null ? null : encodeValues(entry.before),
              "codenine.audit.after": entry.after === null ? null : encodeValues(entry.after),
            }),
          })),
        },
      ],
    },
  ],
});
