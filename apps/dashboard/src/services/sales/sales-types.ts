/**
 * The shapes the dashboard works with.
 *
 * Telegram fields keep the names `apps/api` already returns (`price_vnd`,
 * `on_hand`, `awaiting_payment`...), so a response maps onto them without a
 * rename.
 */

/** Where an item is sold. */
export type StockType = "telegram";

/** `WF` full, `W7D` seven days, `NW` none beyond a one-hour login check. */
export type Warranty = "WF" | "W7D" | "NW";

export interface TelegramProduct {
  type: "telegram";
  slug: string;
  provider: string;
  plan: string;
  variant: string | null;
  warranty: Warranty;
  /** The shop's own warranty note; null when the standard note for the warranty applies. */
  warranty_note: string | null;
  /**
   * What the buyer is told about using the package once they have paid, as the
   * shop wrote it; null when it wrote nothing.
   */
  guide: string | null;
  /**
   * Hands the buyer an account when they have paid. Its count is the accounts not
   * yet sold, so it is not set by hand, and the flag is fixed when it is made.
   */
  delivers_accounts: boolean;
  price_vnd: number;
  /** The count the seller set. */
  on_hand: number;
  /** Held by orders still awaiting payment. */
  reserved: number;
  hot: boolean;
  listed: boolean;
  image_url: string;
}

/** The agents the shop sells accounts of, as the API names them. */
export type AgentProvider =
  "chatgpt" | "gemini" | "claude" | "deepseek" | "grok" | "groq";

export type OrderStatus = "awaiting_payment" | "paid" | "cancelled";

/** A status to show, or every status. */
export type OrderStatusFilter = OrderStatus | "all";

export type PaymentMethod = "bank_transfer" | "usdt" | "cash";

/** An order of the Telegram bot, as the API returns it. */
export interface SaleOrder {
  reference: string;
  /** The buyer on Telegram. */
  customer: { username: string | null; first_name: string };
  item_title: string;
  quantity: number;
  total_vnd: number;
  status: OrderStatus;
  /** Set once the order is paid. */
  payment_method: PaymentMethod | null;
  /**
   * The username of the member of staff who marked it paid or cancelled it; null
   * for what SePay settled and for what the buyer cancelled.
   */
  handled_by: string | null;
  created_at: string;
  expires_at: string;
  paid_at: string | null;
}

export type Role = "owner" | "manager" | "cashier" | "stock-keeper";

export type Permission =
  "orders" | "history" | "stock" | "revenue" | "staff" | "secrets";

export interface StaffMember {
  id: string;
  /**
   * The username of the account this person registered. They sign in as exactly
   * this account; removing the member is what ends their access.
   */
  username: string;
  role: Role;
  /** The last active owner: the role cannot change and the member cannot be removed. */
  locked: boolean;
  /** Null for an account that has never signed in. */
  last_active_at: string | null;
  /** Orders they marked paid today. */
  orders_today: number;
  revenue_today_vnd: number;
}
