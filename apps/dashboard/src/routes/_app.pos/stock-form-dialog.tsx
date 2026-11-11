import { useLayoutEffect, useRef, useState, type ChangeEvent } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { tv } from "tailwind-variants";

import { AccountsChangeConfirm } from "@/components/account-editor-dialog";
import { useDashboardSession } from "@/components/dashboard-shell/dashboard-session-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import Flex from "@/components/ui/flex";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import ProviderSelect, {
  type ProviderOption,
} from "@/components/provider-select";
import {
  serviceProviderLabels,
  warrantyLabels,
} from "@/services/sales/sales-labels";
import type { TelegramProduct, Warranty } from "@/services/sales/sales-types";
import {
  stockService,
  type AccountsEdited,
} from "@/services/stock/stock-service";
import { checkAccountLines } from "@/utils/utils.account-lines";
import {
  caretAfterDigits,
  digitsOf,
  groupDigits,
  stockItemTitle,
} from "@/utils/utils.format";
import slugify from "@/utils/utils.slug";

import {
  checkPackageName,
  composePackageName,
  parsePackageName,
} from "./package-name";
import StockAccounts from "./stock-accounts";
import StockAccountsEditor, {
  type OpenedAccounts,
} from "./stock-accounts-editor";
import StockAdjuster from "./stock-adjuster";

// A cell of the form's grid: half a row, or all of it.
const cell = tv({
  base: "space-y-1.5",
  variants: { full: { true: "col-span-2" } },
});

// Limits `apps/api` enforces on a product.
const MAX_PRICE_VND = 1_000_000_000;
const MAX_INITIAL_STOCK = 1_000_000;
const MAX_RESTOCK = 100_000;

// Telegram refuses a message longer than this.
const MAX_MESSAGE = 4096;

// The longest package note `apps/api` stores.
const MAX_NOTE = 200;

interface Draft {
  provider: string;
  /** The plan and, in brackets at the end, the variant: `Plus 1 tháng (Gia đình)`. */
  name: string;
  warranty: Warranty;
  /** What a buyer reads when they open the package; nothing is shown when empty. */
  note: string;
  price: string;
  /** Units to add (or, negative, take). */
  adjust: string;
  hot: boolean;
  listed: boolean;
  /** What the bot sends to Telegram on save; nothing when empty. */
  message: string;
  /** Hands the buyer an account when they have paid. */
  deliversAccounts: boolean;
  /** Accounts to load on save, one `email|mật khẩu` per line. Never kept anywhere else. */
  accounts: string;
  /** The owner's block of the accounts not sold, as it is being edited. Empty until they are opened. */
  block: string;
}

function draftOf(item: TelegramProduct | null, provider: string): Draft {
  return {
    provider: item?.provider ?? provider,
    name: item ? composePackageName(item) : "",
    warranty: item?.warranty ?? "WF",
    note: item?.warranty_note ?? "",
    price: item ? String(item.price_vnd) : "",
    adjust: "0",
    hot: item?.hot ?? false,
    listed: item?.listed ?? true,
    message: "",
    deliversAccounts: item?.delivers_accounts ?? false,
    accounts: "",
    block: "",
  };
}

interface StockHintInput {
  item: TelegramProduct | null;
  /** What the count comes to after the change. */
  result: number;
  valid: boolean;
}

// What the adjustment comes to, or why it is refused.
function stockHint({ item, result, valid }: StockHintInput) {
  if (!valid) return "Nhập một số nguyên; kho không thể xuống dưới 0.";

  if (item)
    return `Trong kho ${item.on_hand}, đang giữ chỗ ${item.reserved}. Sau khi lưu: ${result} trong kho, bán được ${Math.max(result - item.reserved, 0)}.`;

  return `Sau khi tạo: ${result} trong kho.`;
}

interface StockFormDialogProps {
  /** The package being edited; null creates one. */
  item: TelegramProduct | null;
  /** The provider a new package starts under, when it is added from its card. */
  provider: string;
  /** The providers the shop has, so one that is not an agent Hub William supports can still be edited. */
  providers: string[];
  /** Slugs that already exist, since a duplicate is a conflict. */
  takenSlugs: string[];
  onClose: () => void;
  onDelete: () => void;
  /**
   * `message` is what the bot sends to Telegram on save; empty sends nothing.
   * `accounts` is what is loaded into stock on save; empty loads nothing.
   * `block` is the owner's edit of the accounts they opened, null if none.
   */
  onSave: (
    item: TelegramProduct,
    change: {
      accounts: string;
      block: { ids: string[]; text: string } | null;
      message: string;
    },
  ) => Promise<void>;
}

/** One form to add a package and to edit it: an edit opens already filled in. */
export default function StockFormDialog({
  item,
  onClose,
  onDelete,
  onSave,
  provider,
  providers,
  takenSlugs,
}: StockFormDialogProps) {
  const session = useDashboardSession();
  const [draft, setDraft] = useState(() => draftOf(item, provider));
  const [saving, setSaving] = useState(false);
  // The accounts the owner opened to edit as a block, and what saving it would do.
  const [opened, setOpened] = useState<OpenedAccounts | null>(null);
  const [change, setChange] = useState<AccountsEdited | null>(null);
  // The price is typed as digits and shown grouped (`140000` as `140.000`), so the
  // caret is put back after the same digit it was after, as the dots move.
  const priceField = useRef<HTMLInputElement>(null);
  const priceCaret = useRef<number | null>(null);

  const editing = item !== null;
  // A name left as it opened keeps the plan and variant it came with, since a
  // plan that itself ends in brackets would otherwise be read as a variant.
  const { plan, variant } =
    item && draft.name === composePackageName(item)
      ? item
      : parsePackageName(draft.name);
  const nameProblem = checkPackageName({ plan, variant });
  const slug = item ? item.slug : slugify(draft.provider, plan, variant);
  const adjust = Number(draft.adjust);
  const price = Number(draft.price);
  // A package that hands out accounts counts the accounts loaded, so the stepper
  // does not apply to it.
  const delivers = draft.deliversAccounts;
  const onHand = delivers
    ? (item?.on_hand ?? 0)
    : (item?.on_hand ?? 0) + adjust;
  const accounts = checkAccountLines(draft.accounts);
  const block = checkAccountLines(draft.block);
  const blockChanged = opened !== null && draft.block !== opened.original;
  // Accounts not sold have to be dealt with before a package stops handing them
  // out, so the switch holds until none is left.
  const holdsAccounts = !!item?.delivers_accounts && item.on_hand > 0;
  const message = draft.message.trim();
  const messageValid = message.length <= MAX_MESSAGE;
  const note = draft.note.trim();
  // In characters as the server counts them, line breaks included, so an emoji is
  // one and not the two JavaScript's length makes of it.
  const noteLength = [...note].length;
  const noteValid = noteLength <= MAX_NOTE;
  const slugTaken = !editing && takenSlugs.includes(slug);
  // The agents Hub William supports, chosen from and never typed, so a provider
  // cannot be misspelt into a card of its own. A provider the shop already has
  // under another name stays choosable, so what it has can still be edited.
  const providerOptions: ProviderOption[] = [
    ...Object.values(serviceProviderLabels).map((label) => ({
      icon: label,
      label,
      value: label,
    })),
    ...providers
      .filter(
        (known) =>
          !Object.values(serviceProviderLabels).some(
            (label) => label.toLowerCase() === known.trim().toLowerCase(),
          ),
      )
      .map((known) => ({ icon: known, label: known, value: known })),
  ];
  const priceValid =
    draft.price.trim() !== "" &&
    Number.isInteger(price) &&
    price >= 0 &&
    price <= MAX_PRICE_VND;
  const stockValid =
    delivers ||
    (Number.isInteger(adjust) &&
      onHand >= 0 &&
      adjust <= (editing ? MAX_RESTOCK : MAX_INITIAL_STOCK));
  const valid =
    accounts.problem === null &&
    block.problem === null &&
    messageValid &&
    noteValid &&
    draft.provider.trim() !== "" &&
    plan !== "" &&
    nameProblem === null &&
    slug !== "" &&
    !slugTaken &&
    priceValid &&
    stockValid;

  const product: TelegramProduct = {
    type: "telegram",
    slug,
    provider: draft.provider.trim(),
    plan,
    variant,
    warranty: draft.warranty,
    warranty_note: note || null,
    delivers_accounts: delivers,
    price_vnd: price,
    on_hand: onHand,
    reserved: item?.reserved ?? 0,
    hot: draft.hot,
    listed: draft.listed,
    // No picture is chosen here: the provider's own icon is shown, so a package
    // keeps the address it had and a new one has none.
    image_url: item?.image_url ?? "",
  };

  function set<Key extends keyof Draft>(key: Key, value: Draft[Key]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function changePrice(event: ChangeEvent<HTMLInputElement>) {
    const typed = event.target.value;
    const caret = event.target.selectionStart ?? typed.length;
    const digits = digitsOf(typed).replace(/^0+(?=\d)/, "");

    priceCaret.current = Math.min(
      digitsOf(typed.slice(0, caret)).length,
      digits.length,
    );
    set("price", digits);
  }

  useLayoutEffect(() => {
    if (priceCaret.current === null || !priceField.current) return;

    const at = caretAfterDigits(groupDigits(draft.price), priceCaret.current);

    priceField.current.setSelectionRange(at, at);
    priceCaret.current = null;
  }, [draft.price]);

  // The form stays open, and can be fixed and sent again, when the save fails;
  // the page has already said what went wrong.
  async function submit(saved: TelegramProduct) {
    setSaving(true);

    try {
      await onSave(saved, {
        accounts: delivers && opened === null ? draft.accounts.trim() : "",
        block:
          opened && blockChanged
            ? { ids: opened.ids, text: draft.block }
            : null,
        message,
      });
    } catch {
      // Reported by the page.
    } finally {
      setSaving(false);
    }
  }

  // What editing the opened accounts would change, asked for before anything is written.
  async function check() {
    if (!item || !opened) return;

    setSaving(true);

    try {
      setChange(
        await stockService.editAccounts(item.slug, {
          accounts: draft.block,
          dryRun: true,
          ids: opened.ids,
        }),
      );
    } catch (error) {
      toast.error("Không kiểm tra được thay đổi của tài khoản", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[92svh] overflow-y-auto sm:max-w-xl"
        onOpenAutoFocus={(event) => {
          // Start on the first field, not on whatever the dialog finds first. A new
          // package added from a provider's card has that provider already, so it
          // starts on the package's name.
          event.preventDefault();
          document
            .getElementById(
              item === null && provider !== ""
                ? "stock-plan"
                : "stock-provider",
            )
            ?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {item ? `Sửa ${stockItemTitle(item)}` : "Thêm hàng"}
          </DialogTitle>

          <DialogDescription>
            Một gói bán qua bot Telegram, tính tiền VND.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="stock-provider">Nhà cung cấp</Label>

                <ProviderSelect
                  id="stock-provider"
                  options={providerOptions}
                  value={draft.provider}
                  onChange={(next) => set("provider", next)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="stock-warranty">Bảo hành</Label>

                <Select
                  value={draft.warranty}
                  onValueChange={(next) => set("warranty", next as Warranty)}
                >
                  <SelectTrigger className="w-full" id="stock-warranty">
                    <SelectValue />
                  </SelectTrigger>

                  <SelectContent>
                    {Object.entries(warrantyLabels).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="stock-plan">Tên gói</Label>

                <Input
                  aria-invalid={nameProblem !== null}
                  id="stock-plan"
                  placeholder="Gemini AI PRO your mail"
                  value={draft.name}
                  onChange={(event) => set("name", event.target.value)}
                />

                {nameProblem && (
                  <p className="text-xs text-destructive">{nameProblem}</p>
                )}
              </div>

              <div className="col-span-2 space-y-1.5">
                <Flex className="items-baseline justify-between gap-2">
                  <Label htmlFor="stock-note">Ghi chú gói (tùy chọn)</Label>

                  {noteLength > 0 && (
                    <span
                      className={
                        noteValid
                          ? "text-xs text-muted-foreground tabular-nums"
                          : "text-xs text-destructive tabular-nums"
                      }
                    >
                      {noteLength}/{MAX_NOTE}
                    </span>
                  )}
                </Flex>

                <Textarea
                  aria-invalid={!noteValid}
                  id="stock-note"
                  placeholder="Ví dụ: Giao tài khoản trong 5 phút sau khi thanh toán. Đăng nhập bằng email được gửi, không đổi mật khẩu."
                  rows={3}
                  value={draft.note}
                  onChange={(event) => set("note", event.target.value)}
                />

                {!noteValid && (
                  <p className="text-xs text-destructive">
                    Ghi chú gói dài tối đa {MAX_NOTE} ký tự.
                  </p>
                )}
              </div>

              <div className={cell({ full: delivers })}>
                <Label htmlFor="stock-price">Giá (₫)</Label>

                <Input
                  aria-invalid={draft.price !== "" && !priceValid}
                  id="stock-price"
                  inputMode="numeric"
                  placeholder="189.000"
                  ref={priceField}
                  value={groupDigits(draft.price)}
                  onChange={changePrice}
                />
              </div>

              {!delivers && (
                <>
                  <StockAdjuster
                    invalid={!stockValid}
                    label={
                      editing ? "Thêm hoặc bớt tồn kho" : "Tồn kho ban đầu"
                    }
                    unit="gói"
                    value={draft.adjust}
                    onChange={(next) => set("adjust", next)}
                  />

                  <p
                    className={
                      stockValid
                        ? "col-span-2 text-xs text-muted-foreground"
                        : "col-span-2 text-xs text-destructive"
                    }
                  >
                    {stockHint({ item, result: onHand, valid: stockValid })}
                  </p>
                </>
              )}
            </div>

            {slugTaken && (
              <p className="text-xs text-destructive">Đã có gói này rồi.</p>
            )}
          </>

          {delivers && (
            <div className="space-y-4">
              {item?.delivers_accounts &&
                (session.can("secrets") ? (
                  <StockAccountsEditor
                    item={item}
                    lines={block}
                    opened={opened}
                    text={draft.block}
                    onOpen={(next) => {
                      setOpened(next);
                      set("block", next?.original ?? "");
                    }}
                    onTextChange={(next) => set("block", next)}
                  />
                ) : (
                  <StockAccounts item={item} />
                ))}

              {opened === null && (
                <div className="space-y-1.5">
                  <Flex className="items-baseline justify-between gap-2">
                    <Label htmlFor="stock-accounts">
                      {item?.delivers_accounts
                        ? "Nạp thêm tài khoản"
                        : "Nạp tài khoản"}{" "}
                      (tùy chọn)
                    </Label>

                    {accounts.count > 0 && (
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {accounts.count} tài khoản
                      </span>
                    )}
                  </Flex>

                  <Textarea
                    aria-invalid={accounts.problem !== null}
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    className="font-mono"
                    id="stock-accounts"
                    placeholder={
                      "email1@example.com|mat-khau-1\nemail2@example.com|mat-khau-2"
                    }
                    rows={5}
                    spellCheck={false}
                    value={draft.accounts}
                    onChange={(event) => set("accounts", event.target.value)}
                  />

                  <p
                    className={
                      accounts.problem === null
                        ? "text-xs text-muted-foreground"
                        : "text-xs text-destructive"
                    }
                  >
                    {accounts.problem ??
                      `${
                        item?.delivers_accounts
                          ? `Trong kho ${item.on_hand} tài khoản chưa bán. `
                          : "Tồn kho là số tài khoản đã nạp. "
                      }Mỗi dòng một tài khoản, dạng email|mật khẩu. Một dòng là một tài khoản, kể cả khi email giống nhau. Tài khoản được mã hóa khi lưu.`}
                  </p>
                </div>
              )}
            </div>
          )}

          <Flex className="flex-wrap gap-x-6 gap-y-3">
            <Flex className="items-center gap-2">
              <Switch
                checked={draft.listed}
                id="stock-listed"
                onCheckedChange={(next) => set("listed", next)}
              />

              <Label htmlFor="stock-listed">Đang bán</Label>
            </Flex>

            <Flex className="items-center gap-2">
              <Switch
                checked={draft.hot}
                id="stock-hot"
                onCheckedChange={(next) => set("hot", next)}
              />

              <Label htmlFor="stock-hot">Hot</Label>
            </Flex>

            <Flex className="items-center gap-2">
              <Switch
                checked={draft.deliversAccounts}
                disabled={holdsAccounts}
                id="stock-delivers"
                onCheckedChange={(next) => set("deliversAccounts", next)}
              />

              <Label htmlFor="stock-delivers">Giao tài khoản tự động</Label>
            </Flex>
          </Flex>

          {holdsAccounts && (
            <p className="text-xs text-muted-foreground">
              Còn {item.on_hand} tài khoản chưa bán. Xóa hết các dòng trong danh
              sách tài khoản rồi lưu, sau đó mới tắt giao tự động.
            </p>
          )}

          {item && !item.delivers_accounts && delivers && (
            <p className="text-xs text-muted-foreground">
              Tồn kho sẽ tính theo số tài khoản đã nạp. Gói đang có{" "}
              {item.on_hand} gõ tay, con số này sẽ mất và gói hết hàng cho tới
              khi bạn nạp tài khoản.
            </p>
          )}

          {item?.delivers_accounts && !delivers && (
            <p className="text-xs text-muted-foreground">
              Gói sẽ về tồn kho gõ tay, bắt đầu từ 0. Tài khoản đã bán vẫn được
              giữ lại làm lịch sử.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Flex className="items-baseline justify-between gap-2">
            <Label htmlFor="stock-message">Tin nhắn Telegram (tùy chọn)</Label>

            {message.length > 0 && (
              <span
                className={
                  messageValid
                    ? "text-xs text-muted-foreground tabular-nums"
                    : "text-xs text-destructive tabular-nums"
                }
              >
                {message.length}/{MAX_MESSAGE}
              </span>
            )}
          </Flex>

          <Textarea
            aria-invalid={!messageValid}
            id="stock-message"
            placeholder="Ví dụ: Nhập thêm 20 ChatGPT Plus 1 tháng, bảo hành full, chỉ 189.000 ₫"
            rows={3}
            value={draft.message}
            onChange={(event) => set("message", event.target.value)}
          />

          <p
            className={
              messageValid
                ? "text-xs text-muted-foreground"
                : "text-xs text-destructive"
            }
          >
            {messageValid
              ? "Để trống thì không gửi gì. Có nội dung thì khi lưu, bot đăng đúng nội dung này lên kênh và gửi cho người đã bấm Start, kèm nút “Mua ngay” mở gói này."
              : `Tin nhắn Telegram dài tối đa ${MAX_MESSAGE} ký tự.`}
          </p>
        </div>

        <DialogFooter>
          {editing && (
            <Button
              className="sm:mr-auto"
              variant="destructive"
              disabled={saving}
              onClick={onDelete}
            >
              <Trash2 data-icon="inline-start" />
              Xóa hàng
            </Button>
          )}

          <Button variant="outline" onClick={onClose}>
            Hủy
          </Button>

          <Button
            disabled={!valid || saving}
            onClick={() => void (blockChanged ? check() : submit(product))}
          >
            {editing ? "Lưu" : "Thêm"}
          </Button>
        </DialogFooter>
      </DialogContent>

      {change && (
        <AccountsChangeConfirm
          error={null}
          pending={saving}
          plan={change}
          productTitle={stockItemTitle(product)}
          onBack={() => setChange(null)}
          onConfirm={() => {
            setChange(null);
            void submit(product);
          }}
        />
      )}
    </Dialog>
  );
}
