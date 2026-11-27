import type {
  AgentProvider,
  OrderStatus,
  PaymentMethod,
  Permission,
  Role,
  SaleOrder,
  StockType,
  Warranty,
} from "./sales-types";

export const stockTypeLabels: Record<StockType, string> = {
  telegram: "Telegram",
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

/** The agents the shop sells accounts of, in the order a provider is chosen from. */
export const agentProviderLabels: Record<AgentProvider, string> = {
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
  secrets: "Xem mật khẩu tài khoản trong kho",
};

/** What each role may open. A page without its permission shows no data. */
export const rolePermissions: Record<Role, Permission[]> = {
  owner: ["orders", "history", "stock", "revenue", "staff", "secrets"],
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
