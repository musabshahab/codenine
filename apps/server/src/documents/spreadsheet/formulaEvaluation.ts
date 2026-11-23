import { type FormulaReference, replaceFormulaReferences } from "./references.ts";

export class FormulaErrorValue {
  readonly code: string;
  constructor(code: string) {
    this.code = code;
  }
}

export type FormulaValue = number | string | boolean | null | FormulaErrorValue;

/** The formula uses something this evaluator does not calculate, so its result is unknown. */
// @effect-diagnostics-next-line extendsNativeError:off - thrown and caught inside pure code, never an Effect failure.
export class FormulaNotCalculated extends Error {}

export interface FormulaScope {
  /** The values of the cells a reference names that hold anything. */
  readonly values: (reference: FormulaReference) => ReadonlyArray<FormulaValue>;
}

type Operand =
  | { readonly kind: "scalar"; readonly value: FormulaValue }
  | {
      readonly kind: "cells";
      readonly values: ReadonlyArray<FormulaValue>;
      readonly single: boolean;
    };

type Token =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "operator"; readonly value: string }
  | { readonly kind: "reference"; readonly value: FormulaReference }
  | { readonly kind: "word"; readonly value: string }
  | { readonly kind: "error"; readonly value: string };

const REFERENCE_MARK = "\u0001";
const TOKEN_PATTERN =
  /\s+|(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|"((?:[^"]|"")*)"|(<=|>=|<>|[-+*/^&%=<>(),])|\u0001(\d+)\u0001|([A-Za-z_][\w.]*)|(#[A-Z0-9/]+[!?]?)/y;

function tokenize(formula: string): ReadonlyArray<Token> {
  const references: Array<FormulaReference> = [];
  if (formula.includes(REFERENCE_MARK)) throw new FormulaNotCalculated();
  const marked = replaceFormulaReferences(formula, (reference) => {
    references.push(reference);
    return `${REFERENCE_MARK}${references.length - 1}${REFERENCE_MARK}`;
  });
  const tokens: Array<Token> = [];
  const text = marked.formula;
  for (let index = 0; index < text.length;) {
    TOKEN_PATTERN.lastIndex = index;
    const match = TOKEN_PATTERN.exec(text);
    if (!match) throw new FormulaNotCalculated();
    index += match[0].length;
    if (match[1] !== undefined) tokens.push({ kind: "number", value: Number(match[1]) });
    else if (match[2] !== undefined) {
      tokens.push({ kind: "text", value: match[2].replaceAll('""', '"') });
    } else if (match[3] !== undefined) tokens.push({ kind: "operator", value: match[3] });
    else if (match[4] !== undefined) {
      tokens.push({ kind: "reference", value: references[Number(match[4])]! });
    } else if (match[5] !== undefined) tokens.push({ kind: "word", value: match[5].toUpperCase() });
    else if (match[6] !== undefined) tokens.push({ kind: "error", value: match[6] });
  }
  return tokens;
}

const error = (code: string) => new FormulaErrorValue(code);
const isError = (value: FormulaValue): value is FormulaErrorValue =>
  value instanceof FormulaErrorValue;

// Spreadsheet apps keep fifteen significant digits, which hides binary rounding such as 0.1 + 0.2.
const settle = (value: number): FormulaValue =>
  Number.isFinite(value) ? Number(value.toPrecision(15)) : error("#NUM!");

function toNumber(value: FormulaValue): number | FormulaErrorValue {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null) return 0;
  if (isError(value)) return value;
  const text = value.trim();
  const parsed = text === "" ? Number.NaN : Number(text);
  return Number.isFinite(parsed) ? parsed : error("#VALUE!");
}

function toText(value: FormulaValue): string | FormulaErrorValue {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(Number(value.toPrecision(15)));
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return value === null ? "" : value;
}

function toBoolean(value: FormulaValue): boolean | FormulaErrorValue {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (value === null) return false;
  if (isError(value)) return value;
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  return error("#VALUE!");
}

const scalar = (value: FormulaValue): Operand => ({ kind: "scalar", value });

function single(operand: Operand): FormulaValue {
  if (operand.kind === "scalar") return operand.value;
  // A range where one value is expected picks by position or spills, which is not calculated here.
  if (!operand.single) throw new FormulaNotCalculated();
  return operand.values[0] ?? null;
}

function compare(left: FormulaValue, right: FormulaValue): number {
  const rank = (value: FormulaValue) =>
    typeof value === "number" ? 0 : typeof value === "string" ? 1 : 2;
  const a =
    left === null
      ? typeof right === "string"
        ? ""
        : typeof right === "boolean"
          ? false
          : 0
      : left;
  const b =
    right === null ? (typeof a === "string" ? "" : typeof a === "boolean" ? false : 0) : right;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (typeof a === "string" && typeof b === "string") {
    return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
  }
  return Number(a) - Number(b);
}

/** Numbers an aggregate reads: every number in referenced cells, and each direct value as one. */
function numbers(operands: ReadonlyArray<Operand>): Array<number> | FormulaErrorValue {
  const found: Array<number> = [];
  for (const operand of operands) {
    if (operand.kind === "cells") {
      for (const value of operand.values) {
        if (isError(value)) return value;
        if (typeof value === "number") found.push(value);
      }
      continue;
    }
    const value = toNumber(operand.value);
    if (isError(value)) return value;
    found.push(value);
  }
  return found;
}

const round = (value: number, digits: number, mode: (scaled: number) => number) => {
  const factor = 10 ** digits;
  const scaled = Number((Math.abs(value) * factor).toPrecision(15));
  return settle((Math.sign(value) * mode(scaled)) / factor);
};

type Calculation = (operands: ReadonlyArray<Operand>) => FormulaValue;

const aggregate =
  (reduce: (values: ReadonlyArray<number>) => FormulaValue): Calculation =>
  (operands) => {
    const values = numbers(operands);
    return values instanceof FormulaErrorValue ? values : reduce(values);
  };

const numeric =
  (count: number, calculate: (...values: Array<number>) => FormulaValue): Calculation =>
  (operands) => {
    if (operands.length !== count) throw new FormulaNotCalculated();
    const values: Array<number> = [];
    for (const operand of operands) {
      const value = toNumber(single(operand));
      if (isError(value)) return value;
      values.push(value);
    }
    return calculate(...values);
  };

const textual =
  (calculate: (text: string) => FormulaValue): Calculation =>
  (operands) => {
    if (operands.length !== 1) throw new FormulaNotCalculated();
    const text = toText(single(operands[0]!));
    return isError(text) ? text : calculate(text);
  };

const logical =
  (start: boolean, combine: (all: boolean, next: boolean) => boolean): Calculation =>
  (operands) => {
    let result = start;
    for (const operand of operands) {
      const values = operand.kind === "cells" ? operand.values : [operand.value];
      for (const value of values) {
        if (operand.kind === "cells" && (value === null || typeof value === "string")) continue;
        const next = toBoolean(value);
        if (isError(next)) return next;
        result = combine(result, next);
      }
    }
    return result;
  };

const join: Calculation = (operands) => {
  let joined = "";
  for (const operand of operands) {
    for (const value of operand.kind === "cells" ? operand.values : [operand.value]) {
      const text = toText(value);
      if (isError(text)) return text;
      joined += text;
    }
  }
  return joined;
};

const FUNCTIONS: Record<string, Calculation> = {
  SUM: aggregate((values) => settle(values.reduce((sum, value) => sum + value, 0))),
  PRODUCT: aggregate((values) => settle(values.reduce((product, value) => product * value, 1))),
  AVERAGE: aggregate((values) =>
    values.length === 0
      ? error("#DIV/0!")
      : settle(values.reduce((sum, value) => sum + value, 0) / values.length),
  ),
  // Reduced one by one: spreading a large range into arguments overflows the stack.
  MIN: aggregate((values) =>
    values.reduce((least, value) => Math.min(least, value), values[0] ?? 0),
  ),
  MAX: aggregate((values) => values.reduce((most, value) => Math.max(most, value), values[0] ?? 0)),
  COUNT: (operands) =>
    operands.reduce(
      (count, operand) =>
        count +
        (operand.kind === "cells"
          ? operand.values.filter((value) => typeof value === "number").length
          : isError(toNumber(operand.value))
            ? 0
            : 1),
      0,
    ),
  COUNTA: (operands) =>
    operands.reduce(
      (count, operand) =>
        count +
        (operand.kind === "cells" ? operand.values.filter((value) => value !== null).length : 1),
      0,
    ),
  IF: (operands) => {
    if (operands.length < 2 || operands.length > 3) throw new FormulaNotCalculated();
    const condition = toBoolean(single(operands[0]!));
    if (isError(condition)) return condition;
    const chosen = condition ? operands[1]! : operands[2];
    return chosen === undefined ? false : single(chosen);
  },
  IFERROR: (operands) => {
    if (operands.length !== 2) throw new FormulaNotCalculated();
    const value = single(operands[0]!);
    return isError(value) ? single(operands[1]!) : value;
  },
  AND: logical(true, (all, next) => all && next),
  OR: logical(false, (any, next) => any || next),
  NOT: (operands) => {
    if (operands.length !== 1) throw new FormulaNotCalculated();
    const value = toBoolean(single(operands[0]!));
    return isError(value) ? value : !value;
  },
  ROUND: numeric(2, (value, digits) => round(value, digits!, Math.round)),
  ROUNDUP: numeric(2, (value, digits) => round(value, digits!, Math.ceil)),
  ROUNDDOWN: numeric(2, (value, digits) => round(value, digits!, Math.floor)),
  INT: numeric(1, (value) => Math.floor(value!)),
  ABS: numeric(1, (value) => Math.abs(value!)),
  SQRT: numeric(1, (value) => (value! < 0 ? error("#NUM!") : settle(Math.sqrt(value!)))),
  MOD: numeric(2, (value, divisor) =>
    divisor === 0 ? error("#DIV/0!") : settle(value! - divisor! * Math.floor(value! / divisor!)),
  ),
  POWER: numeric(2, (base, exponent) => settle(base! ** exponent!)),
  LEN: textual((text) => text.length),
  UPPER: textual((text) => text.toUpperCase()),
  LOWER: textual((text) => text.toLowerCase()),
  TRIM: textual((text) => text.trim().replace(/ {2,}/g, " ")),
  CONCATENATE: join,
  CONCAT: join,
};

const BINARY_LEVELS: ReadonlyArray<ReadonlyArray<string>> = [
  ["=", "<>", "<", ">", "<=", ">="],
  ["&"],
  ["+", "-"],
  ["*", "/"],
  ["^"],
];

function applyBinary(operator: string, left: FormulaValue, right: FormulaValue): FormulaValue {
  if (isError(left)) return left;
  if (isError(right)) return right;
  if (operator === "&") return `${toText(left) as string}${toText(right) as string}`;
  if (BINARY_LEVELS[0]!.includes(operator)) {
    const order = compare(left, right);
    switch (operator) {
      case "=":
        return order === 0;
      case "<>":
        return order !== 0;
      case "<":
        return order < 0;
      case ">":
        return order > 0;
      case "<=":
        return order <= 0;
      default:
        return order >= 0;
    }
  }
  const a = toNumber(left);
  if (isError(a)) return a;
  const b = toNumber(right);
  if (isError(b)) return b;
  switch (operator) {
    case "+":
      return settle(a + b);
    case "-":
      return settle(a - b);
    case "*":
      return settle(a * b);
    case "/":
      return b === 0 ? error("#DIV/0!") : settle(a / b);
    default:
      return settle(a ** b);
  }
}

/**
 * The result of a formula that uses only arithmetic, comparison, text joining and the functions
 * above. Throws `FormulaNotCalculated` for anything else, so the caller never stores a guess.
 */
export function evaluateFormula(formula: string, scope: FormulaScope): FormulaValue {
  const tokens = tokenize(formula);
  let position = 0;
  const peekOperator = () => {
    const token = tokens[position];
    return token?.kind === "operator" ? token.value : null;
  };
  const expect = (operator: string) => {
    if (peekOperator() !== operator) throw new FormulaNotCalculated();
    position += 1;
  };

  const binary = (level: number): Operand => {
    if (level === BINARY_LEVELS.length) return unary();
    let left = binary(level + 1);
    for (let operator = peekOperator(); operator !== null; operator = peekOperator()) {
      if (!BINARY_LEVELS[level]!.includes(operator)) break;
      position += 1;
      const right = binary(level + 1);
      left = scalar(applyBinary(operator, single(left), single(right)));
    }
    return left;
  };

  const unary = (): Operand => {
    const operator = peekOperator();
    if (operator === "-" || operator === "+") {
      position += 1;
      const value = toNumber(single(unary()));
      return scalar(isError(value) || operator === "+" ? value : -value);
    }
    let operand = primary();
    while (peekOperator() === "%") {
      position += 1;
      const value = toNumber(single(operand));
      operand = scalar(isError(value) ? value : settle(value / 100));
    }
    return operand;
  };

  const primary = (): Operand => {
    const token = tokens[position];
    if (token === undefined) throw new FormulaNotCalculated();
    position += 1;
    switch (token.kind) {
      case "number":
      case "text":
        return scalar(token.value);
      case "error":
        return scalar(error(token.value));
      case "reference": {
        const reference = token.value;
        return {
          kind: "cells",
          values: scope.values(reference),
          single: reference.end === null,
        };
      }
      case "word": {
        if (peekOperator() !== "(") {
          if (token.value === "TRUE") return scalar(true);
          if (token.value === "FALSE") return scalar(false);
          throw new FormulaNotCalculated();
        }
        const calculate = FUNCTIONS[token.value];
        if (calculate === undefined) throw new FormulaNotCalculated();
        position += 1;
        const operands: Array<Operand> = [];
        if (peekOperator() === ")") position += 1;
        else {
          while (true) {
            operands.push(binary(0));
            if (peekOperator() === ",") position += 1;
            else {
              expect(")");
              break;
            }
          }
        }
        return scalar(calculate(operands));
      }
      case "operator": {
        if (token.value !== "(") throw new FormulaNotCalculated();
        const inner = binary(0);
        expect(")");
        return scalar(single(inner));
      }
    }
  };

  const result = single(binary(0));
  if (position !== tokens.length) throw new FormulaNotCalculated();
  // An empty cell read by a formula shows as zero.
  return result === null ? 0 : result;
}
