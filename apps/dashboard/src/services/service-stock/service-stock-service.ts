import { apiClient, guarded, serviceError } from "@/services/api/api-client";
import type { components } from "@/services/api/api.generated";
import type {
  ListingStatus,
  QuotaMetric,
  ServiceListing,
  ServiceProvider,
  ServiceSale,
  VerifiedAccount,
} from "@/services/sales/sales-types";

type ApiListing = components["schemas"]["DashboardListing"];
type ApiMetric = components["schemas"]["QuotaMetric"];
type ApiSale = components["schemas"]["DashboardTicketSale"];
type ApiVerified = components["schemas"]["VerifiedAccount"];

function metricFromApi(metric: ApiMetric): QuotaMetric {
  return {
    detail: metric.detail ?? null,
    label: metric.label,
    value: metric.value,
  };
}

function listingFromApi(listing: ApiListing): ServiceListing {
  return {
    account_label: listing.account_label ?? null,
    created_at: listing.created_at,
    days: listing.days,
    id: listing.id,
    listed: listing.listed,
    name: listing.name,
    plan: listing.plan ?? null,
    price_micro: listing.price_micro,
    provider: listing.provider as ServiceProvider,
    quota: listing.quota.map(metricFromApi),
    quota_captured_at: listing.quota_captured_at ?? null,
    seller: listing.seller ?? null,
    status: listing.status as ListingStatus,
  };
}

function verifiedFromApi(account: ApiVerified): VerifiedAccount {
  return {
    account_label: account.account_label ?? null,
    captured_at: account.captured_at,
    plan: account.plan ?? null,
    provider: account.provider as ServiceProvider,
    quota: account.quota.map(metricFromApi),
  };
}

function saleFromApi(sale: ApiSale): ServiceSale {
  return {
    buyer: sale.buyer ?? null,
    days: sale.days,
    expires_at: sale.expires_at ?? null,
    id: sale.id,
    key_last_four: sale.key_last_four ?? null,
    name: sale.name,
    price_micro: sale.price_micro,
    provider: sale.provider as ServiceProvider,
    seller: sale.seller ?? null,
    sold_at: sale.sold_at,
  };
}

/** What a ticket is put on sale as, or changed to: the account is not changed. */
export interface ServiceListingTerms {
  name: string;
  days: number;
  /** In micro-dollars, whole cents. */
  price_micro: number;
}

export interface ServiceListingChange extends ServiceListingTerms {
  listed: boolean;
}

/**
 * Hub William's stock: the agent accounts of the staff on sale as tickets, and the
 * tickets that were sold.
 */
class ServiceStockService {
  readonly listingsKey = ["dashboard", "service", "listings"] as const;

  readonly salesKey = ["dashboard", "service", "sales"] as const;

  /** The tickets that are not sold yet. */
  async listings(): Promise<ServiceListing[]> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.GET(
        "/dashboard/service/listings",
      );

      if (!data)
        throw serviceError(response, error, "Không tải được kho Hub William.");

      return data.listings.map(listingFromApi);
    });
  }

  /**
   * Tries an account the member connected: the provider is asked for something
   * through it, and what it has left is read. It rejects with the API's words when
   * the account could not be verified.
   */
  async verify(connectionId: string): Promise<VerifiedAccount> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.POST(
        "/dashboard/service/verify",
        { body: { connection_id: connectionId } },
      );

      if (!data) throw serviceError(response, error, "Không verify được.");

      return verifiedFromApi(data);
    });
  }

  /** Puts a verified account on sale; the API tries it again as it does. */
  async addListing(
    connectionId: string,
    terms: ServiceListingTerms,
  ): Promise<ServiceListing> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.POST(
        "/dashboard/service/listings",
        { body: { connection_id: connectionId, ...terms } },
      );

      if (!data)
        throw serviceError(
          response,
          error,
          "Không thêm được hàng Hub William.",
        );

      return listingFromApi(data);
    });
  }

  /** Changes a ticket that is not sold. */
  async updateListing(
    id: string,
    change: ServiceListingChange,
  ): Promise<ServiceListing> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.PUT(
        "/dashboard/service/listings/{id}",
        { body: change, params: { path: { id } } },
      );

      if (!data) throw serviceError(response, error, "Không lưu được gói.");

      return listingFromApi(data);
    });
  }

  /** Takes a ticket that is not sold off sale. The account is left as it was. */
  async removeListing(id: string): Promise<void> {
    return guarded(async () => {
      const { error, response } = await apiClient.DELETE(
        "/dashboard/service/listings/{id}",
        { params: { path: { id } } },
      );

      if (error) throw serviceError(response, error, "Không gỡ được gói.");
    });
  }

  /** The tickets that were sold, newest first. */
  async sales(): Promise<ServiceSale[]> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.GET(
        "/dashboard/service/sales",
      );

      if (!data)
        throw serviceError(
          response,
          error,
          "Không tải được lịch sử bán Hub William.",
        );

      return data.sales.map(saleFromApi);
    });
  }
}

export const serviceStockService = new ServiceStockService();
