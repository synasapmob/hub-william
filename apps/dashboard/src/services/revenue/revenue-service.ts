import { apiClient, guarded, serviceError } from "@/services/api/api-client";

export type RevenueDays = 7 | 14 | 30;

export interface RevenueDay {
  /** `YYYY-MM-DD`, in shop time. */
  date: string;
  orders: number;
  /** Takings of the day, in đồng. */
  total: number;
}

export interface Revenue {
  days: RevenueDays;
  /** The period and the one before it, oldest first, every day present. */
  daily: RevenueDay[];
  top_items: { title: string; orders: number; total_vnd: number }[];
  by_seller: {
    /** A username; null for what SePay settled. */
    seller: string | null;
    orders: number;
    total_vnd: number;
  }[];
}

class RevenueService {
  readonly queryKey = ["dashboard", "revenue"] as const;

  async get(days: RevenueDays): Promise<Revenue> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.GET(
        "/dashboard/telegram/revenue",
        { params: { query: { days } } },
      );

      if (!data)
        throw serviceError(response, error, "Không tải được doanh thu.");

      return {
        by_seller: data.by_seller.map((row) => ({
          ...row,
          seller: row.seller ?? null,
        })),
        daily: data.daily.map((day) => ({
          date: day.date,
          orders: day.orders,
          total: day.total_vnd,
        })),
        days,
        top_items: data.top_items,
      };
    });
  }
}

export const revenueService = new RevenueService();
