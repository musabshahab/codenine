import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per recorded state of a file in a workspace without Git. The contents are files
  // under the state directory, named by `content_hash`, so equal contents are stored once.
  yield* sql`
    CREATE TABLE IF NOT EXISTS file_versions (
      version_id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_root TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      state TEXT NOT NULL,
      content_hash TEXT,
      byte_length INTEGER NOT NULL,
      mtime_ms REAL,
      change TEXT NOT NULL,
      origin TEXT NOT NULL,
      thread_id TEXT,
      turn_count INTEGER,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_file_versions_path
    ON file_versions(workspace_root, relative_path, version_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_file_versions_content
    ON file_versions(workspace_root, content_hash)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_file_versions_turn
    ON file_versions(thread_id, turn_count)
  `;
});
