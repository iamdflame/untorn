import { describe, expect, it } from "vitest";
import { levenshtein, ned, nedFiles, pyStrip, readText } from "./ned";

describe("ShredBench NED (metric.py semantics)", () => {
  it("is Levenshtein over the longer length", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(ned("kitten", "sitting")).toBeCloseTo(3 / 7, 12);
    expect(ned("abc", "abc")).toBe(0);
    expect(ned("", "abcd")).toBe(1);
    expect(ned("", "")).toBe(0);
  });

  it("counts code points, as Python does", () => {
    // one astral character is one edit, not two UTF-16 units
    expect(levenshtein("a😀b", "ab")).toBe(1);
    expect(ned("a😀b", "ab")).toBeCloseTo(1 / 3, 12);
    expect(ned("新闻报道", "新闻报导")).toBeCloseTo(1 / 4, 12);
  });

  it("strips like Python's str.strip(), not JavaScript's trim()", () => {
    expect(pyStrip(" \t\n　x  ")).toBe("x");
    expect(pyStrip("\u001cx\u001f")).toBe("x"); // Python whitespace, not JavaScript's
    expect(pyStrip("﻿x​")).toBe("﻿x​"); // JavaScript would strip the BOM
  });

  it("reads files with universal newlines before stripping", () => {
    expect(readText("\r\n# Title\r\nline\rnext\r\n\r\n")).toBe("# Title\nline\nnext");
    expect(nedFiles("a\r\nb\n", "\na\nb")).toBe(0);
  });

  it("is symmetric and handles long inputs", () => {
    const a = "The quick brown fox jumps over the lazy dog. ".repeat(60);
    const b = a.replace(/o/g, "0");
    const d = levenshtein(a, b);
    expect(d).toBe((a.match(/o/g) ?? []).length);
    expect(levenshtein(b, a)).toBe(d);
  });
});
