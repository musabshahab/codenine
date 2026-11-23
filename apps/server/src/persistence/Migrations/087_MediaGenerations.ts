import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per image a provider was paid for: how it was made, and what it cost. A row with
  // no path is an image that was charged and could not be saved.
  yield* sql`
    CREATE TABLE IF NOT EXISTS media_generations (
      generation_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      month TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      relative_path TEXT,
      kind TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt TEXT NOT NULL,
      aspect_ratio TEXT,
      seed INTEGER,
      cost_usd REAL NOT NULL,
      cost_estimated INTEGER NOT NULL,
      source_path TEXT,
      mask_path TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_media_generations_month
    ON media_generations(month)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_media_generations_path
    ON media_generations(workspace_root, relative_path, created_at)
  `;
});
