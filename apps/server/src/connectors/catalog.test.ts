import { ConnectorCatalogEntry } from "@codenine/contracts";
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { CONNECTOR_CATALOG } from "./catalog.ts";

const isCatalogEntry = Schema.is(ConnectorCatalogEntry);

it("every library connector can be shown, reached and signed in to", () => {
  const ids = new Set<string>();
  for (const { entry, server, scopes } of CONNECTOR_CATALOG) {
    assert.isTrue(isCatalogEntry(entry), entry.id);
    assert.isFalse(ids.has(entry.id), `${entry.id} is listed twice`);
    ids.add(entry.id);

    const inputKeys = new Set(entry.inputs.map((input) => input.key));
    const usedInputs =
      server.type === "http"
        ? Object.keys(server.queryInputs ?? {})
        : [...Object.keys(server.flagInputs ?? {}), ...Object.keys(server.envInputs ?? {})];
    for (const key of usedInputs) assert.isTrue(inputKeys.has(key), `${entry.id} needs ${key}`);
    assert.strictEqual(entry.runsLocally, server.type === "stdio", entry.id);
    if (server.type === "http") assert.strictEqual(new URL(server.url).protocol, "https:");

    assert.strictEqual(entry.auth === "own-app", entry.ownApp !== undefined, entry.id);
    if (entry.auth === "own-app") assert.isAbove(scopes?.length ?? 0, 0, entry.id);
    if (entry.auth === "token") assert.isDefined(entry.tokenLabel, entry.id);
    // The whole-mailbox scope can delete everything for good.
    assert.notInclude(scopes ?? [], "https://mail.google.com/");
  }
});
