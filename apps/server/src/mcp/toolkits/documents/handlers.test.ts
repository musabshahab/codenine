import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { EnvironmentId, ProviderInstanceId, type RuntimeMode, ThreadId } from "@codenine/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { McpSchema, McpServer } from "effect/ai";

import * as CheckpointStore from "../../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as Documents from "../../../documents/Documents.ts";
import { deckFixture } from "../../../documents/pptx/pptxDeck.testkit.ts";
import { tableWorkbook } from "../../../documents/reply/replyFile.ts";
import * as FileVersionStorage from "../../../fileVersions/FileVersionStorage.ts";
import * as FileVersions from "../../../fileVersions/FileVersions.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as KnownWorkspaces from "../../../workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "../../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";

const threadId = ThreadId.make("documents-thread");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("documents-environment"),
  requestNamespace: "documents-session",
  thread: {
    threadId,
    providerSessionId: "documents-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "documents", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "documents", version: "1" },
  },
  getClient: Effect.die("unused"),
});

// The chat's folder, made per test and read by the mocked project lookup.
const workspace = {
  root: "",
  interactionMode: "default" as "default" | "plan",
  runtimeMode: "full-access" as RuntimeMode,
};

const layer = McpHttpServer.layerDocumentsToolkit.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.sync(() => ({
          ...McpToolAccessTestkit.liveThreadShell(id),
          interactionMode: workspace.interactionMode,
          runtimeMode: workspace.runtimeMode,
        })),
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.sync(() => Option.some({ workspaceRoot: workspace.root } as never)),
    }),
  ),
  Layer.provideMerge(Documents.layer),
  Layer.provideMerge(FileVersions.layer),
  Layer.provide(FileVersionStorage.layer),
  Layer.provide(
    Layer.mock(CheckpointStore.CheckpointStore)({ isGitRepository: () => Effect.succeed(false) }),
  ),
  Layer.provideMerge(
    WorkspaceFileSystem.layer.pipe(
      Layer.provide(
        Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void }),
      ),
      Layer.provide(Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void })),
    ),
  ),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "codenine-mcp-documents-" }),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const LIMITS = {
  maxFileBytes: 1024 * 1024,
  maxUnpackedBytes: 8 * 1024 * 1024,
  maxCells: 10_000,
  maxFormatCells: 10_000,
  maxRecalculationSteps: 100_000,
};

async function formPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([400, 300]);
  const font = document.embedStandardFont(StandardFonts.Helvetica);
  page.drawText("Payment is due within thirty days.", { x: 40, y: 250, size: 12, font });
  page.drawText("Late fees apply after that.", { x: 40, y: 230, size: 12, font });
  const name = document.getForm().createTextField("name");
  name.addToPage(page, { x: 40, y: 150, width: 200, height: 20 });
  document.addPage([400, 300]).drawText("Second page", { x: 40, y: 250, size: 12, font });
  return document.save();
}

const setup = Effect.fn("DocumentsToolkitTest.setup")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const server = yield* McpServer.McpServer;
  const versions = yield* FileVersions.FileVersions;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codenine-mcp-documents-" });
  workspace.root = cwd;
  workspace.interactionMode = "default";
  workspace.runtimeMode = "full-access";
  yield* fileSystem.writeFile(path.join(cwd, "deck.pptx"), yield* Effect.promise(deckFixture));
  yield* fileSystem.writeFile(path.join(cwd, "form.pdf"), yield* Effect.promise(formPdf));
  yield* fileSystem.writeFile(
    path.join(cwd, "plan.xlsx"),
    yield* Effect.promise(() =>
      tableWorkbook(
        [
          ["Item", "Cost"],
          ["Desk", "120"],
          ["Chair", "80"],
        ],
        LIMITS,
      ),
    ),
  );
  // The walk before the turn, which records what each file was.
  yield* versions.syncWorkspace({ cwd, origin: { kind: "turn-start", threadId } });
  const call = (name: string, args: Record<string, unknown>) =>
    server.callTool({ name, arguments: args }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.map((result) => ({
        ok: result.isError !== true,
        value: (result.isError === true
          ? JSON.parse((result.content[0] as { text: string }).text)
          : result.structuredContent) as Record<string, any>,
      })),
    );
  /** Ends the turn as checkpoint capture does, and answers what the turn changed. */
  const endTurn = (turnCount: number) =>
    versions
      .syncWorkspace({ cwd, origin: { kind: "agent", threadId, turnCount } })
      .pipe(Effect.andThen(versions.turnChanges({ cwd, threadId, turnCount })));
  return {
    cwd,
    call,
    endTurn,
    versions,
    readBytes: (name: string) => fileSystem.readFile(path.join(cwd, name)),
  };
});

it.layer(layer)("document tools", (it) => {
  it.effect("reads and edits a workbook, and the edit is the turn's change to discard", () =>
    Effect.gen(function* () {
      const { cwd, call, endTurn, versions, readBytes } = yield* setup();
      const before = yield* readBytes("plan.xlsx");
      const read = yield* call("codenine_spreadsheet_read", { path: "plan.xlsx" });
      expect(read.value).toMatchObject({
        sheets: [{ name: "Table" }],
        sheet: "Table",
        rowCount: 3,
        columnCount: 2,
      });
      expect(read.value.cells).toContainEqual({ row: 1, column: 1, value: 120 });

      const edited = yield* call("codenine_spreadsheet_edit", {
        // An absolute path inside the folder names the same file.
        path: `${cwd}/plan.xlsx`,
        expectedVersion: read.value.version,
        operations: [
          {
            type: "setCell",
            sheet: "Table",
            row: 3,
            column: 0,
            input: { kind: "text", text: "Total" },
          },
          {
            type: "setCell",
            sheet: "Table",
            row: 3,
            column: 1,
            input: { kind: "formula", formula: "=SUM(B2:B3)" },
          },
        ],
      });
      expect(edited.ok).toBe(true);
      const again = yield* call("codenine_spreadsheet_read", { path: "plan.xlsx" });
      expect(again.value.cells).toContainEqual({
        row: 3,
        column: 1,
        value: 200,
        formula: "SUM(B2:B3)",
      });

      // A second edit in the same turn that names the version it read goes through; a stale one
      // is refused with what to do.
      const stale = yield* call("codenine_spreadsheet_edit", {
        path: "plan.xlsx",
        expectedVersion: read.value.version,
        operations: [{ type: "addSheet", name: "Notes" }],
      });
      expect(stale).toMatchObject({
        ok: false,
        value: { code: "invalid_request", message: expect.stringContaining("Read it again") },
      });

      expect(yield* endTurn(1)).toEqual(["plan.xlsx"]);
      const list = yield* versions.list({ cwd, relativePath: "plan.xlsx" });
      expect(list.versions.map((version) => version.origin)).toEqual(["agent", "external"]);
      const baseline = yield* versions.turnBaseline({
        cwd,
        threadId,
        turnCount: 1,
        relativePath: "plan.xlsx",
      });
      expect(Buffer.from(baseline!.bytes!)).toEqual(Buffer.from(before));
    }),
  );

  it.effect("reads a PDF's text and fields, fills a field and highlights quoted text", () =>
    Effect.gen(function* () {
      const { call, endTurn } = yield* setup();
      const read = yield* call("codenine_pdf_read", { path: "form.pdf", pageCount: 1 });
      expect(read.value).toMatchObject({
        pageCount: 2,
        pages: [
          { page: 0, text: "Payment is due within thirty days.\nLate fees apply after that." },
        ],
        fields: [{ name: "name", value: { kind: "text", text: "" }, readOnly: false }],
      });
      expect(read.value.fields[0]).not.toHaveProperty("widgets");

      const edited = yield* call("codenine_pdf_edit", {
        path: "form.pdf",
        expectedVersion: read.value.version,
        fields: [{ name: "name", value: { kind: "text", text: "Ada Lovelace" } }],
        highlights: [{ page: 0, text: "due within  THIRTY days", note: "Check the term" }],
      });
      expect(edited).toMatchObject({ ok: true, value: { highlights: 1, fields: 1 } });

      const documents = yield* Documents.Documents;
      const opened = yield* documents.openPdf({ cwd: workspace.root, relativePath: "form.pdf" });
      expect(opened.fields[0]?.value).toEqual({ kind: "text", text: "Ada Lovelace" });
      expect(opened.annotations).toMatchObject([
        { kind: "highlight", page: 0, contents: "Check the term", removable: true },
      ]);
      // The mark sits on the first line, inside the quoted words and not over the whole line.
      const rect = opened.annotations[0]!.rects![0]!;
      expect(rect.x).toBeGreaterThan(80);
      expect(rect.x + rect.width).toBeLessThan(230);
      expect(rect.y).toBeGreaterThan(240);
      expect(rect.y + rect.height).toBeLessThan(266);

      const missing = yield* call("codenine_pdf_edit", {
        path: "form.pdf",
        highlights: [{ page: 1, text: "not on this page" }],
      });
      expect(missing).toMatchObject({
        ok: false,
        value: { code: "invalid_request", message: expect.stringContaining("not on that page") },
      });
      expect(yield* endTurn(1)).toEqual(["form.pdf"]);
    }),
  );

  it.effect(
    "reads and edits a deck, refuses what it cannot do, and writes nothing in plan mode",
    () =>
      Effect.gen(function* () {
        const { call, endTurn, readBytes } = yield* setup();
        const read = yield* call("codenine_deck_read", { path: "deck.pptx" });
        expect(read.value.layouts).toEqual(["Title Slide", "Title and Content"]);
        expect(read.value.slides).toHaveLength(2);

        const before = yield* readBytes("deck.pptx");
        const refused = yield* call("codenine_deck_edit", {
          path: "deck.pptx",
          operations: [
            { type: "setNotes", slide: 1, notes: "Welcome" },
            { type: "addSlide", layout: "Comparison" },
          ],
        });
        expect(refused).toMatchObject({
          ok: false,
          value: {
            code: "invalid_request",
            message: "This deck has no layout with that name. (operation 1)",
          },
        });
        // Nothing is written unless every operation applies.
        expect(yield* readBytes("deck.pptx")).toEqual(before);

        workspace.interactionMode = "plan";
        const planned = yield* call("codenine_deck_edit", {
          path: "deck.pptx",
          operations: [{ type: "setNotes", slide: 1, notes: "Welcome" }],
        });
        expect(planned).toMatchObject({ ok: false, value: { code: "capability_denied" } });
        expect((yield* call("codenine_deck_read", { path: "deck.pptx" })).ok).toBe(true);
        workspace.interactionMode = "default";

        // A chat that asks before each file change has no approval for these tools to wait on.
        workspace.runtimeMode = "approval-required";
        const notes = { type: "setNotes", slide: 1, notes: "Welcome" };
        const cell = {
          type: "setCell",
          sheet: "Table",
          row: 1,
          column: 1,
          input: { kind: "number", number: 1 },
        };
        const unapproved = [
          yield* call("codenine_deck_edit", { path: "deck.pptx", operations: [notes] }),
          yield* call("codenine_spreadsheet_edit", { path: "plan.xlsx", operations: [cell] }),
          yield* call("codenine_pdf_edit", {
            path: "form.pdf",
            fields: [{ name: "name", value: { kind: "text", text: "Ada" } }],
          }),
        ];
        for (const result of unapproved) {
          expect(result).toMatchObject({ ok: false, value: { code: "capability_denied" } });
        }
        expect(yield* readBytes("deck.pptx")).toEqual(before);
        expect((yield* call("codenine_deck_read", { path: "deck.pptx" })).ok).toBe(true);
        workspace.runtimeMode = "auto-accept-edits";

        const edited = yield* call("codenine_deck_edit", {
          path: "deck.pptx",
          expectedVersion: read.value.version,
          operations: [
            { type: "setText", slide: 2, shape: "body", text: "Up 6%" },
            {
              type: "addSlide",
              layout: "Title and Content",
              text: [{ shape: "title", text: "Next" }],
            },
            { type: "setNotes", slide: 3, notes: "Close here" },
          ],
        });
        expect(edited).toMatchObject({ ok: true, value: { slideCount: 3 } });
        const after = yield* call("codenine_deck_read", { path: "deck.pptx" });
        expect(after.value.slides[1].shapes[1].text).toBe("Up 6%");
        expect(after.value.slides[2]).toMatchObject({ notes: "Close here" });
        expect(yield* endTurn(1)).toEqual(["deck.pptx"]);

        const outside = yield* call("codenine_deck_read", { path: "../elsewhere/deck.pptx" });
        expect(outside).toMatchObject({ ok: false, value: { code: "invalid_request" } });
      }),
  );
});
