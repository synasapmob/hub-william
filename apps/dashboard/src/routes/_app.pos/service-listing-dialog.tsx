import { useState } from "react";
import { Trash2 } from "lucide-react";

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
import { Switch } from "@/components/ui/switch";
import {
  listingStatusLabels,
  serviceProviderLabels,
} from "@/services/sales/sales-labels";
import type { ServiceListing } from "@/services/sales/sales-types";
import type { ServiceListingChange } from "@/services/service-stock/service-stock-service";
import { formatDateTime } from "@/utils/utils.format";

import {
  daysFromTyped,
  MAXIMUM_DAYS,
  priceMicroFromTyped,
  typedFromPriceMicro,
} from "./service-listing-text";

const MAX_NAME = 80;

interface ServiceListingDialogProps {
  listing: ServiceListing;
  onClose: () => void;
  /** Rejects when it could not be saved; the dialog then stays, with what was typed. */
  onSave: (change: ServiceListingChange) => Promise<void>;
  /** Rejects when it could not be taken off sale. */
  onRemove: () => Promise<void>;
}

/**
 * A ticket that is not sold: its name, how many days, its price and whether it is
 * on sale can change, and it can be taken off sale. The account behind it is its
 * owner's and is not changed here.
 */
export default function ServiceListingDialog({
  listing,
  onClose,
  onRemove,
  onSave,
}: ServiceListingDialogProps) {
  const [name, setName] = useState(listing.name);
  const [days, setDays] = useState(String(listing.days));
  const [price, setPrice] = useState(typedFromPriceMicro(listing.price_micro));
  const [listed, setListed] = useState(listing.listed);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const daysValue = daysFromTyped(days);
  const priceValue = priceMicroFromTyped(price);
  const nameValid = name.trim() !== "" && name.trim().length <= MAX_NAME;
  const valid = nameValid && daysValue !== null && priceValue !== null;

  async function run(action: () => Promise<void>) {
    setSaving(true);

    try {
      await action();
    } catch {
      // The page has said why; the dialog stays for another try.
    } finally {
      setSaving(false);
    }
  }

  if (confirming) {
    return (
      <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Gỡ {listing.name} khỏi bán?</DialogTitle>

            <DialogDescription>
              Gói biến khỏi kho và khỏi trang mua. Account vẫn còn nguyên trong
              Agents của bạn, và bạn có thể đem bán lại sau.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button
              disabled={saving}
              variant="outline"
              onClick={() => setConfirming(false)}
            >
              Giữ lại
            </Button>

            <Button
              disabled={saving}
              variant="destructive"
              onClick={() => void run(onRemove)}
            >
              Gỡ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Sửa {listing.name}</DialogTitle>

          <DialogDescription>
            Gói bán account {serviceProviderLabels[listing.provider]}. Đổi tên,
            số ngày, giá, hoặc tắt bán tạm thời.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="listing-name">Tên gói</Label>

            <Input
              aria-invalid={!nameValid}
              id="listing-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />

            {!nameValid && (
              <p className="text-xs text-destructive">
                Tên từ 1 đến {MAX_NAME} ký tự.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="listing-days">Hạn dùng (ngày)</Label>

              <Input
                aria-invalid={daysValue === null}
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
                aria-invalid={priceValue === null}
                id="listing-price"
                inputMode="decimal"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
              />

              {priceValue === null && (
                <p className="text-xs text-destructive">
                  Từ $0.01 đến $10,000, tối đa 2 số lẻ.
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Switch
              checked={listed}
              id="listing-listed"
              onCheckedChange={setListed}
            />

            <Label htmlFor="listing-listed">Đang bán</Label>
          </div>

          <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Account</dt>

            <dd>
              {[listing.account_label, listing.plan]
                .filter(Boolean)
                .join(" · ") || "—"}
            </dd>

            <dt className="text-muted-foreground">Trạng thái</dt>

            <dd>{listingStatusLabels[listing.status]}</dd>

            <dt className="text-muted-foreground">Người bán</dt>

            <dd>{listing.seller ? `@${listing.seller}` : "—"}</dd>

            <dt className="text-muted-foreground">Quota</dt>

            <dd>
              {listing.quota.length > 0 ? (
                <ul>
                  {listing.quota.map((metric) => (
                    <li key={metric.label}>
                      {metric.label}: {metric.value}
                      {metric.detail && ` (${metric.detail})`}
                    </li>
                  ))}
                </ul>
              ) : (
                "Nhà cung cấp không cho đọc quota"
              )}

              {listing.quota_captured_at && (
                <span className="block text-xs text-muted-foreground">
                  Đọc lúc {formatDateTime(listing.quota_captured_at)}
                </span>
              )}
            </dd>
          </dl>
        </div>

        <DialogFooter>
          <Button
            className="sm:mr-auto"
            disabled={saving}
            variant="destructive"
            onClick={() => setConfirming(true)}
          >
            <Trash2 data-icon="inline-start" />
            Gỡ khỏi bán
          </Button>

          <Button disabled={saving} variant="outline" onClick={onClose}>
            Hủy
          </Button>

          <Button
            disabled={!valid || saving}
            onClick={() =>
              void run(() =>
                onSave({
                  days: daysValue ?? listing.days,
                  listed,
                  name: name.trim(),
                  price_micro: priceValue ?? listing.price_micro,
                }),
              )
            }
          >
            Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
