// Shared by the server (Word export) and the browser: "F146, G146, F147, G147" becomes "F146:G147".

export function summarizeCells(cells) {
  if (cells.length <= 2) return cells.join(", ");
  const byColumn = new Map();
  for (const cell of cells) {
    const [, column, row] = /^([A-Z]+)(\d+)$/.exec(cell);
    if (!byColumn.has(column)) byColumn.set(column, []);
    byColumn.get(column).push(Number(row));
  }
  const ranges = [...byColumn]
    .sort(([a], [b]) => a.length - b.length || a.localeCompare(b))
    .map(([column, rows]) => {
      rows.sort((a, b) => a - b);
      const contiguous = rows.every((row, index) => index === 0 || row === rows[index - 1] + 1);
      return { column, first: rows[0], last: rows.at(-1), contiguous, count: rows.length };
    });
  const adjacent = ranges.every(
    (range, index) =>
      index === 0 ||
      (range.column.length === 1 &&
        range.column.charCodeAt(0) === ranges[index - 1].column.charCodeAt(0) + 1),
  );
  const sameRows = ranges.every(
    (range) => range.contiguous && range.first === ranges[0].first && range.last === ranges[0].last,
  );
  if (adjacent && sameRows) {
    return `${ranges[0].column}${ranges[0].first}:${ranges.at(-1).column}${ranges[0].last}`;
  }
  return ranges
    .map((range) =>
      range.first === range.last
        ? `${range.column}${range.first}`
        : range.contiguous
          ? `${range.column}${range.first}:${range.column}${range.last}`
          : `${range.count} cells in ${range.column}${range.first}…${range.column}${range.last}`,
    )
    .join(", ");
}
