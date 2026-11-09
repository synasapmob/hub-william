import type { AccountsEdited, AccountsLoaded } from "./stock-service";

/** What loading accounts did, as the page says it: counts, never accounts. */
export function loadedText({ available, duplicates }: AccountsLoaded) {
  const repeated =
    duplicates > 0 ? `${duplicates} dòng đã có nên được bỏ qua. ` : "";

  return `${repeated}Trong kho còn ${available} tài khoản.`;
}

/** What editing a block of accounts did or would do, in words. */
export function editedText({
  added,
  available,
  changed,
  duplicates,
  removed,
}: AccountsEdited) {
  const done = [
    changed > 0 ? `đổi ${changed}` : null,
    added > 0 ? `thêm ${added}` : null,
    removed > 0 ? `xóa ${removed}` : null,
  ]
    .filter((part) => part !== null)
    .join(", ");

  return [
    done === ""
      ? "Không có gì thay đổi."
      : `${done[0].toUpperCase()}${done.slice(1)}.`,
    duplicates > 0 ? `${duplicates} dòng đã có nên được bỏ qua.` : null,
    `Trong kho còn ${available} tài khoản.`,
  ]
    .filter((part) => part !== null)
    .join(" ");
}
