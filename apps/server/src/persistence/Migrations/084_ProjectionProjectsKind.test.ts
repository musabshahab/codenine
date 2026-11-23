import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@codenine/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("084_ProjectionProjectsKind", (it) => {
  it.effect("turns the projects already stored into code workspaces", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 83 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'project-1', 'Existing', '/work/existing', '[]',
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations();

      assert.deepStrictEqual(yield* sql`SELECT kind FROM projection_projects`, [{ kind: "code" }]);
    }),
  );
});
