/**
 * The shapes the dashboard works with.
 *
 * Telegram fields keep the names `apps/api` already returns (`price_vnd`,
 * `on_hand`, `awaiting_payment`...), so a response maps onto them without a
 * rename. Hub William's stock is tickets: an agent account of the staff, sold once
 * for a number of days at a price.
 */

/** Where an item is sold. One order never mixes both. */
export type StockType = "telegram" | "hub-william";

/**
 * VND is a whole number of đồng. USD is an integer number of micro-dollars
 * (1 USD = 1,000,000), the unit the service wallet already uses.
 */
export type Currency = "VND" | "USD";

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

/** The agents the Service sells, as the API names them. */
export type ServiceProvider =
  "chatgpt" | "gemini" | "claude" | "deepseek" | "grok" | "groq";

/** One line of what an account has left, as its provider reports it. */
export interface QuotaMetric {
  label: string;
  value: string;
  detail: string | null;
}

/**
 * Why a ticket is on the list: `for_sale`, `hidden` (switched off), `needs_reconnect`
 * (its owner has to connect the account again) or `disconnected` (the account is gone).
 */
export type ListingStatus =
  "for_sale" | "hidden" | "needs_reconnect" | "disconnected";

/**
 * A ticket of Hub William's that is not sold yet: an agent account a member of
 * the staff put on sale. Whoever buys it gets a key that runs on that account for
 * `days`. Once it is sold it leaves the stock and is a sale in the history.
 */
export interface ServiceListing {
  id: string;
  provider: ServiceProvider;
  name: string;
  /** How long the key lasts once it is bought. */
  days: number;
  /** In micro-dollars (1 USD = 1,000,000), whole cents. */
  price_micro: number;
  /** Whether it is switched on for sale. */
  listed: boolean;
  status: ListingStatus;
  /** What the account had left when it was verified; empty when the provider does not say. */
  quota: QuotaMetric[];
  quota_captured_at: string | null;
  account_label: string | null;
  plan: string | null;
  /** The staff member who put it on sale. */
  seller: string | null;
  created_at: string;
}

/** An account the provider answered a test request through, and what it has left. */
export interface VerifiedAccount {
  provider: ServiceProvider;
  account_label: string | null;
  plan: string | null;
  quota: QuotaMetric[];
  captured_at: string;
}

/** A ticket that was sold. */
export interface ServiceSale {
  id: string;
  sold_at: string;
  provider: ServiceProvider;
  name: string;
  days: number;
  /** What the customer paid, in micro-dollars. */
  price_micro: number;
  buyer: string | null;
  seller: string | null;
  /** The last four characters of the key the customer got. */
  key_last_four: string | null;
  expires_at: string | null;
}

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
