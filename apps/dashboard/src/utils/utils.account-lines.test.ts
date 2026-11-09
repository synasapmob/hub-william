import { describe, expect, it } from "vitest";

import { checkAccountLines } from "./utils.account-lines";

describe("checkAccountLines", () => {
  it("counts the accounts of a block and skips blank lines", () => {
    expect(
      checkAccountLines(
        "one@example.test|first\n\n  two@example.test | second \r\n   \nthree@example.test|x",
      ),
    ).toEqual({ count: 3, problem: null });
  });

  it("holds nothing for an empty block, and that is not a problem", () => {
    expect(checkAccountLines("")).toEqual({ count: 0, problem: null });
    expect(checkAccountLines("  \n \n")).toEqual({ count: 0, problem: null });
  });

  it("allows a bar inside the password", () => {
    expect(checkAccountLines("a@example.test|p|ipe")).toEqual({
      count: 1,
      problem: null,
    });
  });

  it.each([
    ["no bar", "no-bar-here", "Dòng 2 không đúng dạng email|mật khẩu."],
    ["no email", "|password", "Dòng 2 không đúng dạng email|mật khẩu."],
    [
      "no password",
      "a@example.test|  ",
      "Dòng 2 không đúng dạng email|mật khẩu.",
    ],
    [
      "a control character",
      "a@example.test|pass\tword",
      "Dòng 2 có ký tự điều khiển.",
    ],
    [
      "too many characters",
      `a@example.test|${"x".repeat(300)}`,
      "Dòng 2 dài quá 300 ký tự.",
    ],
  ])("names the line that has %s, and never quotes it", (_, line, problem) => {
    const checked = checkAccountLines(`fine@example.test|ok\n${line}`);

    expect(checked.count).toBe(1);
    expect(checked.problem).toBe(problem);
    expect(checked.problem).not.toContain("example");
  });

  it("counts a line by its characters, as the server does", () => {
    expect(checkAccountLines(`a@b|${"ă".repeat(296)}`).problem).toBeNull();
    expect(checkAccountLines(`a@b|${"ă".repeat(297)}`).problem).toBe(
      "Dòng 1 dài quá 300 ký tự.",
    );
  });

  it("allows 1,000 accounts and refuses 1,001", () => {
    const block = (count: number) =>
      Array.from({ length: count }, (_, n) => `a${n}@example.test|x`).join(
        "\n",
      );

    expect(checkAccountLines(block(1000))).toEqual({
      count: 1000,
      problem: null,
    });
    expect(checkAccountLines(block(1001)).problem).toBe(
      "Tối đa 1000 tài khoản mỗi lần nạp.",
    );
  });
});
