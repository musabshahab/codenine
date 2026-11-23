import { describe, expect, it } from "vite-plus/test";

import { formatNumber } from "./cellFormat";

describe("formatNumber", () => {
  it.each([
    [1234.5, undefined, "1234.5"],
    [0.1 + 0.2, "General", "0.3"],
    [1234.567, "0.00", "1234.57"],
    [1234.5, "#,##0", "1,235"],
    [-1234.5, "#,##0.00", "-1,234.50"],
    [-12, "#,##0;(#,##0)", "(12)"],
    [0.256, "0.0%", "25.6%"],
    [3.5, '0.0" kg"', "3.5 kg"],
    [12.5, "[$€-407]#,##0.00", "€12.50"],
    [5, "000", "005"],
    [1.5, "0.###", "1.5"],
    [12345, "0.00E+00", "1.23E+04"],
    [45292, "yyyy-mm-dd", "2024-01-01"],
    [45292.75, "d mmm yyyy h:mm AM/PM", "1 Jan 2024 6:00 PM"],
    [45292.5104166667, "hh:mm:ss", "12:15:00"],
    [1.5, "[h]:mm", "36:00"],
    [0.5, "# ?/?", "0.5"],
  ])("%d as %s", (value, code, expected) => {
    expect(formatNumber(value, code, false)).toBe(expected);
  });

  it("counts dates from 1904 when the workbook does", () => {
    expect(formatNumber(0, "yyyy-mm-dd", true)).toBe("1904-01-01");
  });
});
