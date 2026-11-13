import { useState } from "react";

import ProviderSelect, {
  type ProviderOption,
} from "@/components/provider-select";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { agentConnectionService } from "@/services/agent-connection/agent-connection-service";
import { serviceProviderLabels } from "@/services/sales/sales-labels";
import type {
  ServiceProvider,
  StockType,
  VerifiedAccount,
} from "@/services/sales/sales-types";

import PlatformSelect from "./platform-select";
import ServiceAccountConnect from "./service-account-connect";
import {
  daysFromTyped,
  listingName,
  MAXIMUM_DAYS,
  priceMicroFromTyped,
} from "./service-listing-text";

const AGENTS: ProviderOption[] = (
  Object.entries(serviceProviderLabels) as [ServiceProvider, string][]
).map(([value, label]) => ({ icon: value, label, value }));

export interface NewListing {
  connectionId: string;
  name: string;
  days: number;
  priceMicro: number;
}

interface ServiceListingFormDialogProps {
  /** The agent to start from, when added from its card. */
  provider: ServiceProvider | null;
  /**
   * Given when the form is opened from "Thêm hàng": it then starts with the choice of
   * platform, and choosing Telegram swaps this form for the Telegram one.
   */
  onPlatform?: (type: StockType) => void;
  onClose: () => void;
  /** Rejects when it could not be put on sale; the page says why and the form stays. */
  onSave: (listing: NewListing) => Promise<void>;
}

/**
 * Puts an agent account on sale as a ticket: the agent, how many days the key lasts
 * once it is bought, the price, and the account itself, connected and verified here.
 * "Thêm" waits for the verification.
 */
export default function ServiceListingFormDialog({
  onClose,
  onPlatform,
  onSave,
  provider: start,
}: ServiceListingFormDialogProps) {
  const [provider, setProvider] = useState<ServiceProvider | "">(start ?? "");
  const [days, setDays] = useState("7");
  const [price, setPrice] = useState("");
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [account, setAccount] = useState<VerifiedAccount | null>(null);
  const [saving, setSaving] = useState(false);

  const daysValue = daysFromTyped(days);
  const priceValue = priceMicroFromTyped(price);
  const valid =
    provider !== "" &&
    connectionId !== null &&
    account !== null &&
    daysValue !== null &&
    priceValue !== null;

  // An account connected here and not put on sale is let go, so it does not sit in
  // the member's Agents without anyone having asked for it.
  function release(id: string | null) {
    if (id) void agentConnectionService.disconnect(id).catch(() => undefined);
  }

  function reset() {
    release(connectionId);
    setConnectionId(null);
    setAccount(null);
  }

  function close() {
    release(connectionId);
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && close()}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Thêm hàng Hub William</DialogTitle>

          <DialogDescription>
            Bán một account agent của bạn thành gói: ai mua sẽ nhận một key chỉ
            chạy trên account này, trong số ngày bạn chọn. Gói đã bán sẽ biến
            khỏi kho và nằm ở Lịch sử bán hàng.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {onPlatform && (
            <div className="space-y-1.5">
              <Label htmlFor="listing-platform">Platform</Label>

              <PlatformSelect
                disabled={saving}
                id="listing-platform"
                value="hub-william"
                onChange={(type) => {
                  // The account connected here is let go, as when the form is closed.
                  release(connectionId);
                  onPlatform(type);
                }}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="listing-provider">Nhà cung cấp</Label>

            <ProviderSelect
              disabled={saving}
              id="listing-provider"
              options={AGENTS}
              value={provider}
              onChange={(next) => {
                reset();
                setProvider(next as ServiceProvider);
              }}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="listing-days">Hạn dùng (ngày)</Label>

              <Input
                aria-invalid={daysValue === null}
                disabled={saving}
                id="listing-days"
                inputMode="numeric"
                value={days}
                onChange={(event) => setDays(event.target.value)}
              />

              {daysValue === null && (
                <p className="text-xs text-destructive">
                  Từ 1 đến {MAXIMUM_DAYS} ngày.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="listing-price">Giá ($)</Label>

              <Input
                aria-invalid={price !== "" && priceValue === null}
                disabled={saving}
                id="listing-price"
                inputMode="decimal"
                placeholder="4.00"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
              />

              {price !== "" && priceValue === null && (
                <p className="text-xs text-destructive">
                  Từ $0.01 đến $10,000, tối đa 2 số lẻ.
                </p>
              )}
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Hạn dùng tính từ lúc người mua bấm Mua. Quota còn lại của account
            hiện sau khi verify.
          </p>

          {provider !== "" && (
            <ServiceAccountConnect
              key={provider}
              disabled={saving}
              provider={provider}
              onConnection={setConnectionId}
              onVerified={setAccount}
            />
          )}
        </div>

        <DialogFooter>
          <Button
            disabled={saving}
            type="button"
            variant="outline"
            onClick={close}
          >
            Hủy
          </Button>

          <Button
            disabled={!valid || saving}
            type="button"
            onClick={async () => {
              if (
                provider === "" ||
                connectionId === null ||
                account === null ||
                daysValue === null ||
                priceValue === null
              )
                return;

              setSaving(true);

              try {
                await onSave({
                  connectionId,
                  days: daysValue,
                  name: listingName(
                    provider,
                    account.plan ?? account.account_label,
                    daysValue,
                  ),
                  priceMicro: priceValue,
                });
              } catch {
                // The page has said why; the form stays for another try.
              } finally {
                setSaving(false);
              }
            }}
          >
            Thêm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
