import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Projects from before workspace kinds are code workspaces.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'code'`;
});
