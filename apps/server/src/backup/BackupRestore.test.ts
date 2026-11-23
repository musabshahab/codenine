import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@codenine/shared/HostProcess";
import * as NodeSqliteClient from "@codenine/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { BUILD_MIGRATION_HEAD } from "../persistence/databaseMigrationHead.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ProcessRunner from "../processRunner.ts";
import { BackupScrypt, createBackup } from "./BackupArchive.ts";
import {
  applyPendingRestore,
  inspectBackup,
  prepareRestore,
  readRestoreReport,
  type RestorePaths,
} from "./BackupRestore.ts";
import { readBackupState } from "./BackupSchedule.ts";

const PASSWORD = "correct horse battery";
const layer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

interface Home {
  readonly name: string;
  readonly userHome: string;
  readonly paths: RestorePaths;
}

const makeHome = Effect.fn(function* (root: string, name: string) {
  const path = yield* Path.Path;
  const userHome = path.join(root, name);
  const baseDir = path.join(userHome, ".codenine");
  const stateDir = path.join(baseDir, "userdata");
  return {
    name,
    userHome,
    paths: {
      baseDir,
      stateDir,
      dbPath: path.join(stateDir, "statev2.sqlite"),
      worktreesDir: path.join(baseDir, "worktrees"),
      environmentIdPath: path.join(stateDir, "environment-id"),
      secretsDir: path.join(stateDir, "secrets"),
      settingsPath: path.join(stateDir, "settings.json"),
      anonymousIdPath: path.join(stateDir, "anonymous-id"),
    },
  } satisfies Home;
});

const writeFile = Effect.fn(function* (file: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, contents);
});

const sql = <A>(
  dbPath: string,
  run: (client: SqlClient.SqlClient) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(run),
    Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
    Effect.orDie,
  );

const now = () => DateTime.formatIso(DateTime.makeUnsafe(Date.parse("2026-11-17T06:00:00Z")));

/** A migrated database with one session, plus the files a running home has. */
const seedHome = Effect.fn(function* (
  home: Home,
  options: { readonly environmentId: string; readonly sessionId: string },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(home.paths.stateDir, { recursive: true });
  yield* sql(home.paths.dbPath, (client) =>
    runMigrations().pipe(
      Effect.andThen(
        client`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
          VALUES (${options.sessionId}, 'owner', '[]', 'pairing', ${now()}, ${now()})`,
      ),
    ),
  );
  yield* writeFile(home.paths.environmentIdPath, `${options.environmentId}\n`);
  yield* writeFile(path.join(home.paths.secretsDir, "server-signing-key.bin"), `${home.name}-key`);
  yield* writeFile(path.join(home.paths.stateDir, "logs", "server.log"), `${home.name} log`);
  yield* writeFile(path.join(home.paths.stateDir, "server-owner.sqlite"), "");
});

/** Alpha: a workspace inside the Codenine folder, one outside it, and two accounts. */
const seedAlpha = Effect.fn(function* (home: Home) {
  const path = yield* Path.Path;
  const codenine = home.paths.baseDir;
  yield* seedHome(home, { environmentId: "env-alpha", sessionId: "alpha-session" });
  const thread = JSON.stringify({
    worktreePath: `${codenine}/worktrees/app/feature`,
    note: `see ${home.userHome}/code/site`,
  });
  yield* sql(home.paths.dbPath, (client) =>
    Effect.all([
      client`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('p-app', 'App', ${`${codenine}/workspaces/app`}, '[]', ${now()}, ${now()}),
               ('p-site', 'Site', ${`${home.userHome}/code/site`}, '[]', ${now()}, ${now()})`,
      client`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
        VALUES ('t-1', 'p-app', 'Thread', 'codex', 'full-access', 'default', ${now()}, ${now()}, ${thread})`,
      client`INSERT INTO provider_session_runtime (thread_id, provider_name, adapter_key, status, last_seen_at)
        VALUES ('t-1', 'codex', 'codex', 'running', ${now()})`,
      client`INSERT INTO file_versions (workspace_root, relative_path, state, content_hash, byte_length, change, origin, created_at)
        VALUES (${`${home.userHome}/code/site`}, 'notes.md', 'stored', 'hash', 5, 'created', 'user', ${now()})`,
    ]),
  );
  yield* writeFile(path.join(codenine, "workspaces", "app", "README.md"), "app");
  yield* writeFile(path.join(codenine, "agents", "code-reviewer", "AGENT.md"), "---\n---\n");
  yield* writeFile(path.join(codenine, "workflows", "weekly-digest", "workflow.json"), "{}\n");
  yield* writeFile(
    path.join(home.userHome, "code", "site", ".git", "config"),
    '[remote "origin"]\n\turl = https://example.com/me/site.git\n',
  );
  yield* writeFile(path.join(codenine, "accounts", "claude", "home", "settings.json"), "{}");
  yield* writeFile(
    home.paths.settingsPath,
    JSON.stringify({
      providerInstances: {
        codex_work: {
          driver: "codex",
          displayName: "Work Codex",
          config: { setupMode: "managed", homePath: `${codenine}/accounts/codex/work` },
        },
        claude_home: {
          driver: "claudeAgent",
          config: { homePath: `${codenine}/accounts/claude/home` },
        },
      },
    }),
  );
  // Codenine's ChatGPT session for codex_work; see ProviderCredentialStore.
  yield* writeFile(
    path.join(
      home.paths.secretsDir,
      "provider-auth-5c99b7f9cff542ee87f3eec4ec5f7bb01ae67f8253bd8dceef48ed0e4a15dc58.bin",
    ),
    "tokens",
  );
  yield* writeFile(path.join(home.paths.secretsDir, "provider-env-a.bin"), "user key");
  yield* writeFile(
    path.join(home.paths.stateDir, "connectors.json"),
    JSON.stringify({
      version: 1,
      connections: [{ custom: { transport: { command: `${home.userHome}/bin/mcp-server` } } }],
    }),
  );
});

const withHome =
  (home: Home, platform: NodeJS.Platform = "linux") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.HomeDirectory, home.userHome),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(BackupScrypt, { n: 2 ** 10, r: 8, p: 1 }),
    );

const backUp = (home: Home, folder: string, environmentId: string) =>
  createBackup({
    paths: home.paths,
    folder,
    password: PASSWORD,
    kind: "manual",
    includeWorktrees: false,
    computerName: home.name,
    environmentId,
    codenineVersion: "0.1.7",
  }).pipe(withHome(home));

const setup = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse("2026-11-17T06:00:00Z"));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "codenine-restore-" }),
  );
  const alpha = yield* makeHome(root, "Alpha");
  const beta = yield* makeHome(root, "Beta");
  yield* seedAlpha(alpha);
  yield* seedHome(beta, { environmentId: "env-beta", sessionId: "beta-session" });
  yield* writeFile(path.join(beta.paths.baseDir, "workspaces", "old", "notes.txt"), "beta");
  return { root, alpha, beta, backups: path.join(root, "backups") };
});

const projects = (dbPath: string) =>
  sql(
    dbPath,
    (client) =>
      client<{ readonly project_id: string; readonly workspace_root: string }>`
      SELECT project_id, workspace_root FROM projection_projects ORDER BY project_id`,
  );

const sessionIds = (dbPath: string) =>
  sql(
    dbPath,
    (client) => client<{ readonly session_id: string }>`SELECT session_id FROM auth_sessions`,
  ).pipe(Effect.map((rows) => rows.map((row) => row.session_id)));

it.effect(
  "restoring another computer's backup moves its data in, rewrites paths and resets identity",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { alpha, beta, backups } = yield* setup;
      const { file } = yield* backUp(alpha, backups, "env-alpha").pipe(withHome(alpha, "darwin"));

      const prepared = yield* prepareRestore({
        paths: beta.paths,
        filePath: file.path,
        password: PASSWORD,
        computerName: "Beta",
        codenineVersion: "0.1.7",
      }).pipe(withHome(beta, "darwin"));
      assert.isFalse(prepared.summary.fromThisComputer);
      assert.deepEqual(prepared.summary.contents, {
        workspaces: 2,
        chats: 1,
        accounts: 1,
        savedKeys: 1,
        skills: 0,
      });
      yield* applyPendingRestore(beta.paths).pipe(withHome(beta, "darwin"));

      const betaCodenine = beta.paths.baseDir;
      // Data moved in; the replaced data is gone; this computer's runtime files stayed.
      assert.isTrue(yield* fs.exists(path.join(betaCodenine, "workspaces", "app", "README.md")));
      assert.isTrue(
        yield* fs.exists(path.join(betaCodenine, "agents", "code-reviewer", "AGENT.md")),
      );
      assert.isTrue(
        yield* fs.exists(path.join(betaCodenine, "workflows", "weekly-digest", "workflow.json")),
      );
      assert.isFalse(yield* fs.exists(path.join(betaCodenine, "workspaces", "old")));
      assert.equal(
        yield* fs.readFileString(path.join(beta.paths.stateDir, "logs", "server.log")),
        "Beta log",
      );
      assert.isTrue(yield* fs.exists(path.join(beta.paths.stateDir, "server-owner.sqlite")));
      for (const leftover of ["restore-staging", "restore-previous", "restore-pending.json"]) {
        assert.isFalse(yield* fs.exists(path.join(betaCodenine, leftover)), leftover);
      }

      // Paths that started with the old Codenine folder or home now point here.
      assert.deepEqual(yield* projects(beta.paths.dbPath), [
        { project_id: "p-app", workspace_root: `${betaCodenine}/workspaces/app` },
        { project_id: "p-site", workspace_root: `${beta.userHome}/code/site` },
      ]);
      const [thread] = yield* sql(
        beta.paths.dbPath,
        (client) =>
          client<{
            readonly payload_json: string;
          }>`SELECT payload_json FROM orchestration_v2_projection_threads`,
      );
      assert.deepEqual(JSON.parse(thread!.payload_json), {
        worktreePath: `${betaCodenine}/worktrees/app/feature`,
        // Prose that mentions a path stays as written.
        note: `see ${alpha.userHome}/code/site`,
      });
      const settings = JSON.parse(yield* fs.readFileString(beta.paths.settingsPath));
      assert.equal(
        settings.providerInstances.codex_work.config.homePath,
        `${betaCodenine}/accounts/codex/work`,
      );
      const connectors = JSON.parse(
        yield* fs.readFileString(path.join(beta.paths.stateDir, "connectors.json")),
      );
      assert.equal(
        connectors.connections[0].custom.transport.command,
        `${beta.userHome}/bin/mcp-server`,
      );

      // A new identity: sessions, runs in flight, signing keys and the ChatGPT session are gone.
      assert.deepEqual(yield* sessionIds(beta.paths.dbPath), []);
      const [runtime] = yield* sql(
        beta.paths.dbPath,
        (client) =>
          client<{
            readonly count: number;
          }>`SELECT (SELECT COUNT(*) FROM provider_session_runtime)
            + (SELECT COUNT(*) FROM file_versions) AS count`,
      );
      // File versions go too: the archive leaves their stored contents out.
      assert.equal(runtime!.count, 0);
      const environmentId = (yield* fs.readFileString(beta.paths.environmentIdPath)).trim();
      assert.notInclude(["env-alpha", "env-beta", ""], environmentId);
      const secrets = yield* fs.readDirectory(beta.paths.secretsDir);
      assert.deepEqual(secrets.toSorted(), ["backup-password.bin", "provider-env-a.bin"]);
      assert.equal(
        yield* fs.readFileString(path.join(beta.paths.secretsDir, "backup-password.bin")),
        PASSWORD,
      );

      const report = yield* readRestoreReport(beta.paths.stateDir);
      assert.isNotNull(report);
      assert.equal(report!.fromComputer, "Alpha");
      assert.isFalse(report!.fromThisComputer);
      assert.isTrue(report!.devicesSignedOut);
      assert.deepEqual(report!.missingWorkspaces, [
        {
          projectId: "p-site",
          title: "Site",
          path: `${beta.userHome}/code/site`,
          remoteUrl: "https://example.com/me/site.git",
        },
      ] as unknown as typeof report.missingWorkspaces);
      assert.deepEqual(
        report!.accountsToSignIn.map((account) => [account.instanceId, account.displayName]),
        [
          ["codex_work", "Work Codex"],
          ["claude_home", "Claude (claude_home)"],
        ],
      );
      assert.equal(report!.safetyBackup?.kind, "before-restore");
      assert.isTrue(yield* fs.exists(report!.safetyBackup!.path));
      assert.equal(report!.undoUntil, "2026-11-24T06:00:00.000Z");

      // Undo brings back this computer's own data and identity, and is final.
      yield* prepareRestore({
        paths: beta.paths,
        filePath: report!.safetyBackup!.path,
        password: PASSWORD,
        computerName: "Beta",
        codenineVersion: "0.1.7",
        undo: true,
      }).pipe(withHome(beta, "darwin"));
      yield* applyPendingRestore(beta.paths).pipe(withHome(beta, "darwin"));
      assert.equal(
        yield* fs.readFileString(path.join(betaCodenine, "workspaces", "old", "notes.txt")),
        "beta",
      );
      assert.isFalse(yield* fs.exists(path.join(betaCodenine, "workspaces", "app")));
      assert.isFalse(yield* fs.exists(path.join(betaCodenine, "agents")));
      assert.isFalse(yield* fs.exists(path.join(betaCodenine, "workflows")));
      assert.equal((yield* fs.readFileString(beta.paths.environmentIdPath)).trim(), "env-beta");
      assert.deepEqual(yield* sessionIds(beta.paths.dbPath), ["beta-session"]);
      const undone = yield* readRestoreReport(beta.paths.stateDir);
      assert.isTrue(undone?.undone);
      assert.isTrue(undone?.fromThisComputer);
      assert.isNull(undone?.safetyBackup);
      assert.isNull(undone?.undoUntil);
      assert.deepEqual(yield* fs.readDirectory(path.join(betaCodenine, "restore-undo")), [
        path.basename(report!.safetyBackup!.path),
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("a restore that fails part way puts the previous data back", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { alpha, beta, backups } = yield* setup;
    const { file } = yield* backUp(alpha, backups, "env-alpha");
    yield* prepareRestore({
      paths: beta.paths,
      filePath: file.path,
      password: PASSWORD,
      computerName: "Beta",
      codenineVersion: "0.1.7",
    }).pipe(withHome(beta));
    // The staged database is damaged, so editing it after the swap fails.
    yield* fs.writeFileString(
      path.join(beta.paths.baseDir, "restore-staging", "userdata", "statev2.sqlite"),
      "not a database",
    );
    yield* applyPendingRestore(beta.paths).pipe(withHome(beta));

    assert.isTrue(
      yield* fs.exists(path.join(beta.paths.baseDir, "workspaces", "old", "notes.txt")),
    );
    assert.isFalse(yield* fs.exists(path.join(beta.paths.baseDir, "workspaces", "app")));
    assert.deepEqual(yield* sessionIds(beta.paths.dbPath), ["beta-session"]);
    assert.equal((yield* fs.readFileString(beta.paths.environmentIdPath)).trim(), "env-beta");
    assert.equal(
      yield* fs.readFileString(path.join(beta.paths.secretsDir, "server-signing-key.bin")),
      "Beta-key",
    );
    for (const leftover of ["restore-staging", "restore-previous", "restore-pending.json"]) {
      assert.isFalse(yield* fs.exists(path.join(beta.paths.baseDir, leftover)), leftover);
    }
    assert.isNull(yield* readRestoreReport(beta.paths.stateDir));
    assert.match(
      (yield* readBackupState(beta.paths.stateDir)).lastError ?? "",
      /could not be applied/,
    );

    // The process dies after one folder moved: the next start finds the journal and moves it back.
    yield* prepareRestore({
      paths: beta.paths,
      filePath: file.path,
      password: PASSWORD,
      computerName: "Beta",
      codenineVersion: "0.1.7",
    }).pipe(withHome(beta));
    const live = path.join(beta.paths.baseDir, "workspaces");
    const staged = path.join(beta.paths.baseDir, "restore-staging", "workspaces");
    const previous = path.join(beta.paths.baseDir, "restore-previous", "workspaces");
    yield* writeFile(
      path.join(beta.paths.baseDir, "restore-previous", "journal.json"),
      JSON.stringify({ moves: [{ live, staged, previous }] }),
    );
    yield* fs.rename(live, previous);
    yield* fs.rename(staged, live);
    yield* applyPendingRestore(beta.paths).pipe(withHome(beta));

    assert.isTrue(yield* fs.exists(path.join(live, "old", "notes.txt")));
    assert.isFalse(yield* fs.exists(path.join(live, "app")));
    assert.deepEqual(yield* sessionIds(beta.paths.dbPath), ["beta-session"]);
    for (const leftover of ["restore-staging", "restore-previous", "restore-pending.json"]) {
      assert.isFalse(yield* fs.exists(path.join(beta.paths.baseDir, leftover)), leftover);
    }
    assert.match((yield* readBackupState(beta.paths.stateDir)).lastError ?? "", /interrupted/);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("an interrupted restore stops unpacking and leaves nothing behind", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { alpha, beta, backups } = yield* setup;
    const { file } = yield* backUp(alpha, backups, "env-alpha");
    const unpacking = Deferred.makeUnsafe<void>();

    const fiber = yield* prepareRestore({
      paths: beta.paths,
      filePath: file.path,
      password: PASSWORD,
      computerName: "Beta",
      codenineVersion: "0.1.7",
      onProgress: (_fraction, detail) => {
        if (detail === "Unpacking the backup") Deferred.doneUnsafe(unpacking, Effect.void);
      },
    }).pipe(withHome(beta), Effect.forkChild);
    yield* Deferred.await(unpacking);
    yield* Fiber.interrupt(fiber);

    assert.isFalse(yield* fs.exists(path.join(beta.paths.baseDir, "restore-staging")));
    assert.isFalse(yield* fs.exists(path.join(beta.paths.baseDir, "restore-pending.json")));
    assert.deepEqual(yield* fs.readDirectory(path.join(beta.paths.baseDir, "restore-undo")), []);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("refuses a backup from a newer Codenine, at inspection and at startup", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { alpha, beta, backups } = yield* setup;
    const current = yield* backUp(alpha, backups, "env-alpha");
    yield* sql(
      alpha.paths.dbPath,
      (client) =>
        client`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${BUILD_MIGRATION_HEAD + 1}, 'FromTheFuture')`,
    );
    const newer = yield* backUp(alpha, backups, "env-alpha");

    const { summary } = yield* inspectBackup({
      paths: beta.paths,
      filePath: newer.file.path,
      password: PASSWORD,
    }).pipe(withHome(beta));
    assert.match(summary.blockedReason ?? "", /newer version of Codenine/);
    const refused = yield* prepareRestore({
      paths: beta.paths,
      filePath: newer.file.path,
      password: PASSWORD,
      computerName: "Beta",
      codenineVersion: "0.1.7",
    }).pipe(withHome(beta), Effect.flip);
    assert.equal(refused.reason, "newer-version");

    // Staged by this version, then started by an older one.
    yield* prepareRestore({
      paths: beta.paths,
      filePath: current.file.path,
      password: PASSWORD,
      computerName: "Beta",
      codenineVersion: "0.1.7",
    }).pipe(withHome(beta));
    const marker = path.join(beta.paths.baseDir, "restore-pending.json");
    yield* fs.writeFileString(
      marker,
      (yield* fs.readFileString(marker)).replace(
        /"schemaVersion":\d+/,
        `"schemaVersion":${BUILD_MIGRATION_HEAD + 1}`,
      ),
    );
    yield* applyPendingRestore(beta.paths).pipe(withHome(beta));

    assert.isTrue(
      yield* fs.exists(path.join(beta.paths.baseDir, "workspaces", "old", "notes.txt")),
    );
    assert.deepEqual(yield* sessionIds(beta.paths.dbPath), ["beta-session"]);
    assert.isFalse(yield* fs.exists(marker));
    assert.match((yield* readBackupState(beta.paths.stateDir)).lastError ?? "", /newer version/);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("restoring this computer's own backup keeps its identity and today's sign-ins", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { beta, backups } = yield* setup;
    const { file } = yield* backUp(beta, backups, "env-beta");
    // Since the backup: one device paired, and the old session revoked.
    yield* sql(beta.paths.dbPath, (client) =>
      Effect.all([
        client`DELETE FROM auth_sessions`,
        client`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
          VALUES ('beta-new', 'owner', '[]', 'pairing', ${now()}, ${now()})`,
      ]),
    );
    yield* fs.remove(path.join(beta.paths.baseDir, "workspaces", "old"), { recursive: true });

    const prepared = yield* prepareRestore({
      paths: beta.paths,
      filePath: file.path,
      password: PASSWORD,
      computerName: "Beta",
      codenineVersion: "0.1.7",
    }).pipe(withHome(beta));
    assert.isTrue(prepared.summary.fromThisComputer);
    yield* applyPendingRestore(beta.paths).pipe(withHome(beta));

    assert.isTrue(
      yield* fs.exists(path.join(beta.paths.baseDir, "workspaces", "old", "notes.txt")),
    );
    assert.equal((yield* fs.readFileString(beta.paths.environmentIdPath)).trim(), "env-beta");
    assert.equal(
      yield* fs.readFileString(path.join(beta.paths.secretsDir, "server-signing-key.bin")),
      "Beta-key",
    );
    assert.deepEqual(yield* sessionIds(beta.paths.dbPath), ["beta-new"]);
    const report = yield* readRestoreReport(beta.paths.stateDir);
    assert.isTrue(report?.fromThisComputer);
    assert.isFalse(report?.devicesSignedOut);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
