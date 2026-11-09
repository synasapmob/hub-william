import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";
import type { TelegramProduct } from "@/services/sales/sales-types";
import {
  stockService,
  type StockAccount,
} from "@/services/stock/stock-service";

interface StockAccountsProps {
  /** A package that hands out accounts. */
  item: TelegramProduct;
}

/** Who loaded an account and where it stands, without its password. */
function standing(account: StockAccount) {
  const sold = account.order_reference
    ? `Đã bán · đơn ${account.order_reference}`
    : "Chưa bán";

  return account.loaded_by ? `${sold} · nạp bởi ${account.loaded_by}` : sold;
}

/**
 * The accounts in stock for a package, for those who may not open them: each with
 * its email hidden, whether it is sold, who loaded it, and a button to take an
 * unsold one out. A collaborator's list is only what they loaded. The owner sees
 * `StockAccountsEditor` instead.
 */
export default function StockAccounts({ item }: StockAccountsProps) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<string | null>(null);

  const accounts = useQuery({
    queryFn: () => stockService.accounts(item.slug),
    queryKey: stockService.accountsKey(item.slug),
  });
  const remove = useMutation({
    mutationFn: (id: string) => stockService.removeAccount(id),
    onError: (error) =>
      toast.error("Không xóa được tài khoản", { description: error.message }),
    onSettled: () =>
      // The accounts and the stock list both sit under the stock key.
      queryClient.invalidateQueries({ queryKey: stockService.queryKey }),
    onSuccess: (available) => {
      setConfirming(null);
      toast.success("Đã xóa tài khoản", {
        description: `Trong kho còn ${available} tài khoản.`,
      });
    },
  });

  const rows = accounts.data ?? [];
  const unsold = rows.filter((account) => !account.order_reference);

  if (accounts.status === "pending") {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        Đang tải tài khoản…
      </p>
    );
  }

  if (accounts.status === "error") {
    return (
      <p className="text-xs text-destructive" role="alert">
        {accounts.error.message}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <Flex className="items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Tài khoản trong kho</p>

        <span className="text-xs text-muted-foreground tabular-nums">
          {unsold.length} chưa bán · {rows.length - unsold.length} đã bán
        </span>
      </Flex>

      {rows.length > 0 ? (
        <ul className="max-h-56 divide-y overflow-y-auto rounded-md border">
          {rows.map((account) => (
            <li className="flex items-center gap-2 px-3 py-2" key={account.id}>
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="truncate font-mono text-sm">
                  {account.email_hint}
                </p>

                <p className="text-xs text-muted-foreground">
                  {standing(account)}
                </p>
              </div>

              {!account.order_reference &&
                (confirming === account.id ? (
                  <>
                    <Button
                      disabled={remove.isPending}
                      size="sm"
                      variant="destructive"
                      onClick={() => remove.mutate(account.id)}
                    >
                      Xóa thật
                    </Button>

                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setConfirming(null)}
                    >
                      Hủy
                    </Button>
                  </>
                ) : (
                  <Button
                    aria-label={`Xóa tài khoản ${account.email_hint}`}
                    size="sm"
                    variant="outline"
                    onClick={() => setConfirming(account.id)}
                  >
                    Xóa
                  </Button>
                ))}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">Chưa có tài khoản nào.</p>
      )}
    </div>
  );
}
