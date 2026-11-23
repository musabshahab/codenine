import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// What a save did beyond changing the contents, such as placing the user's signature.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE file_versions ADD COLUMN action TEXT`;
});
