import { apiClient, guarded, serviceError } from "@/services/api/api-client";
import type { components } from "@/services/api/api.generated";
import type { TelegramProduct, Warranty } from "@/services/sales/sales-types";
import { apiUrl } from "@/utils/utils.api-url";

type ApiProduct = components["schemas"]["DashboardProduct"];

/** What can be edited about a package; the slug and the count cannot. */
export interface StockInput {
  provider: string;
  plan: string;
  variant: string | null;
  warranty: Warranty;
  /** What a buyer reads about the warranty; null asks for the standard note. */
  warranty_note: string | null;
  price_vnd: number;
  hot: boolean;
  listed: boolean;
  /** An address from `imageUrl`, or empty for no picture. */
  image_url: string;
}

/** What the bot did with an announcement. */
export interface Announced {
  /** Whether the channel got it. */
  channel: boolean;
  /** How many chats the bot has started sending it to. */
  audience: number;
}

export interface NewStock extends StockInput {
  /** The count to start from. */
  stock: number;
}

const IMAGE_PATH = /\/dashboard\/images\/([0-9a-f-]{36})$/i;

/** Where a stored picture is served from. */
export function imageUrl(imageId: string) {
  return apiUrl(`/dashboard/images/${imageId}`);
}

/** The id inside an address made by `imageUrl`; null for any other address. */
export function imageIdOf(url: string) {
  return IMAGE_PATH.exec(url)?.[1] ?? null;
}

function productFromApi(product: ApiProduct): TelegramProduct {
  return {
    type: "telegram",
    slug: product.slug,
    provider: product.provider,
    plan: product.plan,
    variant: product.variant ?? null,
    warranty: product.warranty as Warranty,
    warranty_note: product.warranty_note ?? null,
    price_vnd: product.price_vnd,
    on_hand: product.on_hand,
    reserved: product.reserved,
    hot: product.hot,
    listed: product.listed,
    image_url: product.image_id ? imageUrl(product.image_id) : "",
  };
}

function fieldsOf(input: StockInput) {
  return {
    hot: input.hot,
    image_id: imageIdOf(input.image_url),
    listed: input.listed,
    plan: input.plan,
    price_vnd: input.price_vnd,
    provider: input.provider,
    variant: input.variant,
    warranty: input.warranty,
    // Blank asks the server for the standard note, which is what null means.
    warranty_note: input.warranty_note ?? "",
  };
}

/** The Telegram stock the bot sells from, as the dashboard reads and changes it. */
class StockService {
  readonly queryKey = ["dashboard", "stock"] as const;

  async list(): Promise<TelegramProduct[]> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.GET(
        "/dashboard/telegram/products",
      );

      if (!data)
        throw serviceError(response, error, "Không tải được kho hàng.");

      return data.products.map(productFromApi);
    });
  }

  async create(input: NewStock): Promise<TelegramProduct> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.POST(
        "/dashboard/telegram/products",
        { body: { ...fieldsOf(input), available: input.stock } },
      );

      if (!data) throw serviceError(response, error, "Không thêm được hàng.");

      return productFromApi(data);
    });
  }

  async update(slug: string, input: StockInput): Promise<TelegramProduct> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.PUT(
        "/dashboard/telegram/products/{slug}",
        { body: fieldsOf(input), params: { path: { slug } } },
      );

      if (!data) throw serviceError(response, error, "Không lưu được hàng.");

      return productFromApi(data);
    });
  }

  /** Puts stock in (positive) or takes it out (negative). */
  async changeStock(slug: string, delta: number): Promise<TelegramProduct> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.POST(
        "/dashboard/telegram/products/{slug}/stock",
        { body: { delta }, params: { path: { slug } } },
      );

      if (!data) throw serviceError(response, error, "Không đổi được tồn kho.");

      return productFromApi(data);
    });
  }

  async remove(slug: string): Promise<void> {
    return guarded(async () => {
      const { error, response } = await apiClient.DELETE(
        "/dashboard/telegram/products/{slug}",
        { params: { path: { slug } } },
      );

      if (error) throw serviceError(response, error, "Không xóa được hàng.");
    });
  }

  /**
   * Has the bot send a message to the channel and to every chat it can reach.
   * Naming a package adds a "Mua ngay" button that opens it in the bot.
   */
  async announce(text: string, product?: string): Promise<Announced> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.POST(
        "/dashboard/telegram/announcements",
        { body: { product, text } },
      );

      if (!data)
        throw serviceError(response, error, "Bot không gửi được tin nhắn.");

      return data;
    });
  }
}

export const stockService = new StockService();
