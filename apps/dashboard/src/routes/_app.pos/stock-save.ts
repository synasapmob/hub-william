import { stockService } from "@/services/stock/stock-service";
import type { TelegramProduct } from "@/services/sales/sales-types";

interface SaveStock {
  /** What the form produced. */
  saved: TelegramProduct;
  /** What it started from; null when the package is new. */
  previous: TelegramProduct | null;
}

/**
 * Puts what the form produced on the server. The API keeps the edit of a package
 * and the change of its count apart, so an edit that moves the count is two
 * calls: the fields first, then the difference in stock.
 */
export async function saveStock({
  previous,
  saved,
}: SaveStock): Promise<TelegramProduct> {
  const fields = {
    hot: saved.hot,
    image_url: saved.image_url,
    listed: saved.listed,
    plan: saved.plan,
    price_vnd: saved.price_vnd,
    provider: saved.provider,
    variant: saved.variant,
    warranty: saved.warranty,
    warranty_note: saved.warranty_note,
  };

  if (previous === null)
    return stockService.create({
      ...fields,
      delivers_accounts: saved.delivers_accounts,
      stock: saved.on_hand,
    });

  const edited = await stockService.update(previous.slug, fields);
  const delta = saved.on_hand - previous.on_hand;

  return delta === 0 ? edited : stockService.changeStock(previous.slug, delta);
}
