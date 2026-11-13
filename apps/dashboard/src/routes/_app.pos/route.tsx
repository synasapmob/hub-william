import { useState } from "react";
import { Plus, Search } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useDashboardSession } from "@/components/dashboard-shell/dashboard-session-context";
import PageBody from "@/components/page-body";
import PageHeader from "@/components/page-header";
import PermissionGate from "@/components/permission-gate";
import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";
import { Input } from "@/components/ui/input";
import type {
  ServiceListing,
  ServiceProvider,
  TelegramProduct,
} from "@/services/sales/sales-types";
import {
  serviceStockService,
  type ServiceListingChange,
} from "@/services/service-stock/service-stock-service";
import { editedText, loadedText } from "@/services/stock/stock-labels";
import {
  stockService,
  type AccountsEdited,
  type AccountsLoaded,
  type Announced,
} from "@/services/stock/stock-service";
import { iconService } from "@/services/icons/icon-service";
import { formatUsd, stockItemTitle } from "@/utils/utils.format";
import slugify from "@/utils/utils.slug";

import ServiceListingDialog from "./service-listing-dialog";
import ServiceListingFormDialog, {
  type NewListing,
} from "./service-listing-form-dialog";
import { listingSearchText } from "./service-listing-text";
import StockDeleteDialog from "./stock-delete-dialog";
import StockFormDialog from "./stock-form-dialog";
import StockList from "./stock-list";
import { saveStock } from "./stock-save";
import StockTypeFilter, {
  type StockTypeFilterValue,
} from "./stock-type-filter";

// What the open dialog is about; at most one is open at a time. A new package
// may start from a provider, when it is added from that provider's card. Opened from
// "Thêm hàng" (`platform`), a form starts with the choice of platform, and choosing
// the other one swaps one form for the other.
type OpenDialog =
  | {
      kind: "form";
      item: TelegramProduct | null;
      provider: string;
      platform?: boolean;
    }
  | { kind: "delete"; item: TelegramProduct }
  | {
      kind: "listing-form";
      provider: ServiceProvider | null;
      platform?: boolean;
    }
  | { kind: "listing"; listing: ServiceListing };

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : undefined;
}

// What the bot did with a message, as far as it knows when it answers: chats are
// sent to one by one, so the count is how many it has started on.
function announcedText({ audience, channel }: Announced) {
  const chats = `${audience} người đã bấm Start`;

  if (channel) return `Bot đã đăng lên kênh và đang gửi cho ${chats}.`;

  return audience > 0
    ? `Bot đang gửi cho ${chats}. Chưa có kênh nào nhận tin.`
    : "Bot không có kênh hay chat nào để gửi tới.";
}

export default function PosRoute() {
  const queryClient = useQueryClient();
  const session = useDashboardSession();
  const [type, setType] = useState<StockTypeFilterValue>("all");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<OpenDialog | null>(null);

  const stock = useQuery({
    // A role without the stock permission is shown the refusal, not an error.
    enabled: session.can("stock"),
    queryFn: () => stockService.list(),
    queryKey: stockService.queryKey,
  });
  // Hub William's own stock: the agent accounts of the staff on sale as tickets.
  const listings = useQuery({
    enabled: session.can("stock"),
    queryFn: () => serviceStockService.listings(),
    queryKey: serviceStockService.listingsKey,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: stockService.queryKey });
  // Refreshed even when it fails: an edit can land and the stock change after it not.
  const save = useMutation({ mutationFn: saveStock, onSettled: refresh });
  const remove = useMutation({
    mutationFn: (slug: string) => stockService.remove(slug),
    onSettled: refresh,
  });

  const refreshListings = () =>
    queryClient.invalidateQueries({
      queryKey: serviceStockService.listingsKey,
    });
  const addListing = useMutation({
    mutationFn: (input: NewListing) =>
      serviceStockService.addListing(input.connectionId, {
        days: input.days,
        name: input.name,
        price_micro: input.priceMicro,
      }),
    onSettled: refreshListings,
  });
  const updateListing = useMutation({
    mutationFn: ({
      change,
      listing,
    }: {
      change: ServiceListingChange;
      listing: ServiceListing;
    }) => serviceStockService.updateListing(listing.id, change),
    onSettled: refreshListings,
  });
  const removeListing = useMutation({
    mutationFn: (listing: ServiceListing) =>
      serviceStockService.removeListing(listing.id),
    onSettled: refreshListings,
  });

  const items = stock.data ?? [];
  const needle = query.trim().toLowerCase();
  const visible = items.filter(
    (item) =>
      type !== "hub-william" &&
      // The provider is not in the name, but a search for it still finds its packages.
      `${item.provider} ${stockItemTitle(item)}`.toLowerCase().includes(needle),
  );
  const visibleListings = (listings.data ?? []).filter((listing) =>
    listingSearchText(listing).includes(needle),
  );
  // Only what the filter shows decides whether the page is waiting or failed.
  const shown = [
    ...(type === "hub-william" ? [] : [stock]),
    ...(type === "telegram" ? [] : [listings]),
  ];
  const status = shown.some((source) => source.status === "error")
    ? "error"
    : shown.some((source) => source.status === "pending")
      ? "pending"
      : "success";

  return (
    <PermissionGate permission="stock">
      <PageBody>
        <PageHeader
          description="Mỗi card là một nhà cung cấp. Card Telegram chứa các gói bán qua bot: bấm nút sửa để đổi tên, giá, tồn kho, hoặc Thêm gói để thêm vào đúng nhà cung cấp đó. Card Hub William là kho riêng của Hub William, không liên quan tới kho Telegram: mỗi gói là một account agent của nhân viên, bán một lần với số ngày và giá đã chọn. Bán rồi thì gói biến khỏi kho và nằm ở Lịch sử bán hàng; nhà cung cấp chưa có gói nào thì không có card."
          title="Hàng hóa và kho"
        />

        <Flex className="flex-wrap items-center justify-between gap-3">
          <div className="relative max-w-md min-w-48 flex-1">
            <Search
              aria-hidden={true}
              className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />

            <Input
              aria-label="Tìm hàng"
              className="h-10 pl-9"
              placeholder="Tìm theo tên hàng"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <Flex className="items-center gap-3">
            <StockTypeFilter value={type} onValueChange={setType} />

            <Button
              size="lg"
              onClick={() =>
                setDialog({
                  kind: "form",
                  item: null,
                  platform: true,
                  provider: "",
                })
              }
            >
              <Plus data-icon="inline-start" />
              Thêm hàng
            </Button>
          </Flex>
        </Flex>

        <StockList
          error={
            messageOf(
              shown.find((source) => source.status === "error")?.error,
            ) ?? null
          }
          items={visible}
          listings={visibleListings}
          query={needle}
          status={status}
          type={type}
          onAdd={(provider) =>
            setDialog({ kind: "form", item: null, provider })
          }
          onEdit={(item) => setDialog({ kind: "form", item, provider: "" })}
          onAddListing={(provider) =>
            setDialog({ kind: "listing-form", provider })
          }
          onEditListing={(listing) => setDialog({ kind: "listing", listing })}
          onRetry={() =>
            void Promise.all(
              shown
                .filter((source) => source.status === "error")
                .map((source) => source.refetch()),
            )
          }
        />

        {dialog?.kind === "form" && (
          <StockFormDialog
            item={dialog.item}
            provider={dialog.provider}
            providers={[
              ...new Set([
                ...items.map((item) => item.provider),
                // A provider that was just named has no package yet.
                ...(dialog.provider ? [dialog.provider] : []),
              ]),
            ]}
            takenSlugs={items.map((item) => item.slug)}
            onPlatform={
              dialog.platform
                ? () =>
                    setDialog({
                      kind: "listing-form",
                      platform: true,
                      provider: null,
                    })
                : undefined
            }
            onClose={() => setDialog(null)}
            onDelete={() =>
              dialog.item && setDialog({ kind: "delete", item: dialog.item })
            }
            onSave={async (saved, { accounts, block, icon, message }) => {
              const title = `${dialog.item ? "Đã lưu" : "Đã thêm"} ${stockItemTitle(saved)}`;

              let stocked;

              try {
                // A provider made in the form takes its icon before its first package
                // is saved, so its card has the icon when it first appears.
                if (icon) {
                  await iconService.assign(slugify(saved.provider), icon);
                  void queryClient.invalidateQueries({
                    queryKey: iconService.queryKey,
                  });
                }

                stocked = await save.mutateAsync({
                  previous: dialog.item,
                  saved,
                });
              } catch (error) {
                toast.error("Không lưu được", {
                  description: messageOf(error),
                });

                // The form stays open, with what was typed, to be fixed.
                throw error;
              }

              setDialog(null);

              // The package is saved either way; only the accounts may not go in.
              // A message about new stock that did not arrive would be false, so
              // none is sent then.
              let loaded: AccountsLoaded | null = null;
              let edited: AccountsEdited | null = null;

              if (accounts !== "") {
                try {
                  loaded = await stockService.loadAccounts(
                    stocked.slug,
                    accounts,
                  );
                } catch (error) {
                  void refresh();
                  toast.warning(title, {
                    description: `Chưa nạp được tài khoản: ${messageOf(error) ?? "máy chủ không trả lời."} Gói đã được lưu; mở lại gói để nạp.`,
                  });

                  return;
                }
              }

              // The accounts the owner opened and edited as a block go in the same way.
              if (block) {
                try {
                  edited = await stockService.editAccounts(stocked.slug, {
                    accounts: block.text,
                    dryRun: false,
                    ids: block.ids,
                  });
                } catch (error) {
                  void refresh();
                  toast.warning(title, {
                    description: `Chưa lưu được thay đổi của tài khoản: ${messageOf(error) ?? "máy chủ không trả lời."} Gói đã được lưu; mở lại gói để sửa tài khoản.`,
                  });

                  return;
                }
              }

              // The count on the page is the one before the accounts went in.
              if (loaded || edited) void refresh();

              const loadedNote = loaded
                ? loadedText(loaded)
                : edited
                  ? editedText(edited)
                  : "";

              if (message === "") {
                if (loadedNote === "") toast.success(title);
                else toast.success(title, { description: loadedNote });

                return;
              }

              // The stock is saved either way; only the message may not go out.
              try {
                const announced = await stockService.announce(
                  message,
                  stocked.slug,
                );

                toast.success(title, {
                  description: [loadedNote, announcedText(announced)]
                    .filter(Boolean)
                    .join(" "),
                });
              } catch (error) {
                toast.warning(title, {
                  description: `Tin nhắn Telegram chưa được gửi: ${messageOf(error) ?? "bot không trả lời."}`,
                });
              }
            }}
          />
        )}

        {dialog?.kind === "listing-form" && (
          <ServiceListingFormDialog
            provider={dialog.provider}
            onPlatform={
              dialog.platform
                ? () =>
                    setDialog({
                      kind: "form",
                      item: null,
                      platform: true,
                      provider: "",
                    })
                : undefined
            }
            onClose={() => setDialog(null)}
            onSave={async (input) => {
              let added;

              try {
                added = await addListing.mutateAsync(input);
              } catch (error) {
                toast.error("Không thêm được hàng Hub William", {
                  description: messageOf(error),
                });

                // The form stays, with the account that was verified, to try again.
                throw error;
              }

              setDialog(null);
              toast.success(`Đã thêm ${added.name} lên bán`, {
                description: `${formatUsd(added.price_micro)} · ${added.days} ngày. Ai mua sẽ nhận một key chỉ chạy trên account này.`,
              });
            }}
          />
        )}

        {dialog?.kind === "listing" && (
          <ServiceListingDialog
            listing={dialog.listing}
            onClose={() => setDialog(null)}
            onRemove={async () => {
              const { listing } = dialog;

              try {
                await removeListing.mutateAsync(listing);
              } catch (error) {
                toast.error("Không gỡ được gói khỏi bán", {
                  description: messageOf(error),
                });

                throw error;
              }

              setDialog(null);
              toast(`Đã gỡ ${listing.name} khỏi bán`);
            }}
            onSave={async (change) => {
              const { listing } = dialog;

              try {
                await updateListing.mutateAsync({ change, listing });
              } catch (error) {
                toast.error("Không lưu được gói", {
                  description: messageOf(error),
                });

                throw error;
              }

              setDialog(null);
              toast.success(`Đã lưu ${change.name}`);
            }}
          />
        )}

        {dialog?.kind === "delete" && (
          <StockDeleteDialog
            item={dialog.item}
            onClose={() => setDialog(null)}
            onDelete={async () => {
              const { item } = dialog;

              try {
                await remove.mutateAsync(item.slug);
              } catch (error) {
                toast.error("Không xóa được", {
                  description: messageOf(error),
                });
                setDialog(null);

                return;
              }

              setDialog(null);
              toast(`Đã xóa ${stockItemTitle(item)}`);
            }}
          />
        )}
      </PageBody>
    </PermissionGate>
  );
}
