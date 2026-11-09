// The limits `apps/api` enforces on a block of accounts.
export const MAX_ACCOUNT_LINES = 1000;
const MAX_ACCOUNT_CHARACTERS = 300;

// Tab, newline and the other control characters (Unicode category Cc, as the
// server reads it), which a password never needs.
function hasControlCharacter(line: string) {
  return [...line].some((character) => {
    const code = character.codePointAt(0) ?? 0;

    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}

export interface AccountLines {
  /** How many accounts the block holds, up to the first line that is wrong. */
  count: number;
  /** What is wrong with the block, or null. It names a line, never quotes it. */
  problem: string | null;
}

/**
 * Reads a pasted block of accounts, one `email|mật khẩu` per line, the way the
 * server will. The block is the secret, so a problem says which line is wrong and
 * nothing of what it says.
 */
export function checkAccountLines(text: string): AccountLines {
  let count = 0;

  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();

    if (line === "") continue;

    const number = index + 1;

    if ([...line].length > MAX_ACCOUNT_CHARACTERS)
      return {
        count,
        problem: `Dòng ${number} dài quá ${MAX_ACCOUNT_CHARACTERS} ký tự.`,
      };

    if (hasControlCharacter(line))
      return { count, problem: `Dòng ${number} có ký tự điều khiển.` };

    const bar = line.indexOf("|");

    if (
      bar < 0 ||
      line.slice(0, bar).trim() === "" ||
      line.slice(bar + 1).trim() === ""
    )
      return {
        count,
        problem: `Dòng ${number} không đúng dạng email|mật khẩu.`,
      };

    count += 1;
  }

  if (count > MAX_ACCOUNT_LINES)
    return {
      count,
      problem: `Tối đa ${MAX_ACCOUNT_LINES} tài khoản mỗi lần nạp.`,
    };

  return { count, problem: null };
}
