// @effect-diagnostics nodeBuiltinImport:off - the test reads the server's own source files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";

const SERVER_SOURCE = NodePath.join(import.meta.dirname, "..");

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });

const relative = (path: string) => NodePath.relative(SERVER_SOURCE, path).replaceAll("\\", "/");

// Only a person signs a document. Signing is one service method with one caller, the RPC a
// user's client makes, so this fails when an agent tool or any other code gains a way to sign.
it("gives agents no way to place a signature on a PDF", () => {
  const files = sourceFiles(SERVER_SOURCE).map((path) => ({
    path: relative(path),
    source: NodeFS.readFileSync(path, "utf8"),
  }));

  expect(
    files.filter((file) => file.source.includes("editPdfWithSignatures")).map((file) => file.path),
  ).toEqual(["documents/Documents.ts", "ws.ts"]);

  // The code under the service takes signatures directly, so only the service may reach it.
  expect(
    files
      .filter((file) => !file.path.startsWith("documents/pdf/"))
      .filter((file) => /pdfEdits/.test(file.source))
      .map((file) => file.path),
  ).toEqual(["documents/Documents.ts"]);

  const agentCode = files.filter((file) => file.path.startsWith("mcp/"));
  expect(agentCode.length).toBeGreaterThan(10);
  expect(
    agentCode
      .filter((file) =>
        /PdfSignaturePlacement|PdfEditInput|placeSignature|pdfEdits|\bsignatures\b/.test(
          file.source,
        ),
      )
      .map((file) => file.path),
  ).toEqual([]);

  const toolNames = agentCode.flatMap((file) =>
    Array.from(file.source.matchAll(/Tool\.make\(\s*"([^"]+)"/g), (match) => match[1]!),
  );
  expect(toolNames.length).toBeGreaterThan(10);
  expect(toolNames.filter((name) => /(^|_)sign(_|$|ature|ing)/.test(name))).toEqual([]);
});
