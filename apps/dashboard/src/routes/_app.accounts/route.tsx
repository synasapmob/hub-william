import { useState } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { toast } from "sonner";

import AccountEditorDialog from "@/components/account-editor-dialog";
import { useDashboardSession } from "@/components/dashboard-shell/dashboard-session-context";
import PageBody from "@/components/page-body";
import PageHeader from "@/components/page-header";
import PermissionGate from "@/components/permission-gate";
import TablePagination from "@/components/table-pagination";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ACCOUNTS_PAGE_SIZE,
  stockService,
  type AccountStatusFilter,
  type StockAccount,
} from "@/services/stock/stock-service";
import useDebouncedValue from "@/utils/utils.debounced-value";

import AccountAddDialog from "./account-add-dialog";
import AccountEditDialog from "./account-edit-dialog";
import AccountRemoveDialog from "./account-remove-dialog";
import AccountsStatusFilter from "./accounts-status-filter";
import AccountsTable from "./accounts-table";
import PackageAccountsEditor from "./package-accounts-editor";

// What the open dialog is about; at most one is open at a time.
type OpenDialog =
  | { kind: "add" }
  | { kind: "package"; slug: string }
  | { kind: "reveal" | "edit" | "remove"; account: StockAccount };

export default function AccountsRoute() {
  const queryClient = useQueryClient();
  const session = useDashboardSession();
  const [status, setStatus] = useState<AccountStatusFilter>("all");
  const [product, setProduct] = useState("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);

  const search = useDebouncedValue(query.trim());
  // The packages that hand out accounts, to choose among.
  const packages = useQuery({
    // A role without the stock permission is shown the refusal, not an error.
    enabled: session.can("stock"),
    queryFn: () => stockService.list(),
    queryKey: stockService.queryKey,
  });
  const accounts = useQuery({
    enabled: session.can("stock"),
    placeholderData: keepPreviousData,
    queryFn: () =>
      stockService.searchAccounts({
        page,
        product: product === "all" ? null : product,
        query: search,
        status,
      }),
    // Under the stock key, so a change to the stock looks again.
    queryKey: [
      ...stockService.queryKey,
      "accounts",
      "all",
      { page, product, search, status },
    ],
  });
  const remove = useMutation({
    mutationFn: (id: string) => stockService.removeAccount(id),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: stockService.queryKey }),
  });

  // The packages that hand out accounts, which are the ones to load them into.
  const delivering = (packages.data ?? []).filter(
    (item) => item.delivers_accounts,
  );

  // Taking out the last account of a page can leave the page beyond the end.
  const total = accounts.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / ACCOUNTS_PAGE_SIZE));
  if (accounts.data && !accounts.isPlaceholderData && page > lastPage)
    setPage(lastPage);

  return (
    <PermissionGate permission="stock">
      <PageBody>
        <PageHeader
          description="Mọi tài khoản đã nạp, chưa bán và đã bán, của các gói giao tự động. Email được che; chỉ chủ shop xem được mật khẩu."
          title="Tài khoản"
        >
          <Button
            disabled={packages.data === undefined}
            onClick={() => setDialog({ kind: "add" })}
          >
            <Plus aria-hidden={true} />
            Thêm tài khoản
          </Button>
        </PageHeader>

        <AccountsStatusFilter
          counts={accounts.data?.counts}
          value={status}
          onValueChange={(next) => {
            setStatus(next);
            setPage(1);
          }}
        />

        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search
              aria-hidden={true}
              className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />

            <Input
              aria-label="Tìm tài khoản"
              className="h-10 pl-9"
              placeholder="Tìm theo email đầy đủ, mã đơn, gói hoặc người nạp..."
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
          </div>

          <Select
            value={product}
            onValueChange={(next) => {
              setProduct(next);
              setPage(1);
            }}
          >
            <SelectTrigger aria-label="Lọc theo gói" className="h-10 sm:w-64">
              <SelectValue />
            </SelectTrigger>

            <SelectContent>
              <SelectItem value="all">Tất cả các gói</SelectItem>

              {delivering.map((item) => (
                <SelectItem key={item.slug} value={item.slug}>
                  {item.provider} {item.plan}
                  {item.variant && ` (${item.variant})`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {product !== "all" && session.can("secrets") && (
            <Button
              variant="outline"
              onClick={() => setDialog({ kind: "package", slug: product })}
            >
              Xem / sửa cả gói
            </Button>
          )}
        </div>

        <AccountsTable
          accounts={accounts.data?.accounts ?? []}
          canReveal={session.can("secrets")}
          error={accounts.error?.message ?? null}
          status={accounts.status}
          onEdit={(account) => setDialog({ kind: "edit", account })}
          onRemove={(account) => setDialog({ kind: "remove", account })}
          onReveal={(account) => setDialog({ kind: "reveal", account })}
          onRetry={() => void accounts.refetch()}
        />

        <TablePagination
          page={page}
          pageSize={ACCOUNTS_PAGE_SIZE}
          total={total}
          unit="tài khoản"
          onPageChange={setPage}
        />

        {dialog?.kind === "add" && (
          <AccountAddDialog
            initialProduct={product}
            packages={delivering}
            onClose={() => setDialog(null)}
          />
        )}

        {dialog?.kind === "edit" && (
          <AccountEditDialog
            account={dialog.account}
            onClose={() => setDialog(null)}
          />
        )}

        {dialog?.kind === "reveal" && (
          <AccountEditorDialog
            accounts={[dialog.account]}
            onClose={() => setDialog(null)}
          />
        )}

        {dialog?.kind === "package" && (
          <PackageAccountsEditor
            slug={dialog.slug}
            onClose={() => setDialog(null)}
          />
        )}

        {dialog?.kind === "remove" && (
          <AccountRemoveDialog
            account={dialog.account}
            onClose={() => setDialog(null)}
            onRemove={() =>
              remove.mutate(dialog.account.id, {
                onError: (error) =>
                  toast.error("Không xóa được tài khoản", {
                    description: error.message,
                  }),
                onSuccess: (available) => {
                  setDialog(null);
                  toast.success("Đã xóa tài khoản", {
                    description: `Trong kho còn ${available} tài khoản.`,
                  });
                },
              })
            }
          />
        )}
      </PageBody>
    </PermissionGate>
  );
}
