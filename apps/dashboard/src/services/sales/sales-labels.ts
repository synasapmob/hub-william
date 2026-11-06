import type {
  Currency,
  ListingStatus,
  OrderStatus,
  PaymentMethod,
  Permission,
  Role,
  SaleOrder,
  ServiceProvider,
  StockType,
  Warranty,
} from "./sales-types";

export const stockTypeLabels: Record<StockType, string> = {
  telegram: "Telegram",
  "hub-william": "Hub William",
};

export const stockTypeCurrency: Record<StockType, Currency> = {
  telegram: "VND",
  "hub-william": "USD",
};

export const orderStatusLabels: Record<OrderStatus, string> = {
  awaiting_payment: "Chờ thanh toán",
  paid: "Đã thanh toán",
  cancelled: "Đã hủy",
};

export const paymentMethodLabels: Record<PaymentMethod, string> = {
  bank_transfer: "Chuyển khoản",
  usdt: "USDT",
  cash: "Tiền mặt",
};

export const warrantyLabels: Record<Warranty, string> = {
  WF: "Bảo hành full",
  W7D: "Bảo hành 7 ngày",
  NW: "Không bảo hành",
};

/** What a ticket that is not for sale says about why. */
export const listingStatusLabels: Record<ListingStatus, string> = {
  for_sale: "Đang bán",
  hidden: "Đang ẩn",
  needs_reconnect: "Cần kết nối lại",
  disconnected: "Account đã gỡ",
};

/** The agents Hub William supports, in the order its Pricing page lists them. */
export const serviceProviderLabels: Record<ServiceProvider, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  claude: "Claude",
  deepseek: "DeepSeek",
  grok: "Grok",
  groq: "Groq",
};

export const roleLabels: Record<Role, string> = {
  owner: "Chủ shop",
  manager: "Quản lý",
  cashier: "Thu ngân",
  "stock-keeper": "Thủ kho",
};

export const permissionLabels: Record<Permission, string> = {
  orders: "Xem và xử lý đơn hàng",
  history: "Xem lịch sử bán hàng",
  stock: "Thêm, sửa, xóa hàng và nhập kho",
  revenue: "Xem doanh thu",
  staff: "Quản lý nhân viên",
};

/** What each role may open. A page without its permission shows no data. */
export const rolePermissions: Record<Role, Permission[]> = {
  owner: ["orders", "history", "stock", "revenue", "staff"],
  manager: ["orders", "history", "stock", "revenue"],
  cashier: ["orders", "history"],
  "stock-keeper": ["stock"],
};

/**
 * Who dealt with an order. Nobody did while it waits; on a settled order with no
 * member of staff behind it, SePay or the buyer did it.
 */
export function orderHandlerLabel(order: SaleOrder) {
  if (order.handled_by) return order.handled_by;

  if (order.status === "paid") return "SePay (tự động)";

  return order.status === "cancelled" ? "Khách tự hủy" : "—";
}
