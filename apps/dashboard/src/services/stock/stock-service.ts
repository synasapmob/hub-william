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
  /** The count to start from; always 0 for a package that hands out accounts. */
  stock: number;
  /** Fixed once the package is made. */
  delivers_accounts: boolean;
}

/** What loading accounts did. Never the accounts themselves. */
export interface AccountsLoaded {
  added: number;
  /** The count of the package now: the accounts not yet sold. */
  available: number;
  /** Lines left out because the package already holds exactly that account. */
  duplicates: number;
}

/**
 * An account in stock as a page lists it: the email hidden but for its first
 * letter and its domain, and no password.
 */
export type StockAccount = components["schemas"]["StockAccount"];

/** An account opened for the owner: its id, and the line `email|mật khẩu`. */
export type RevealedAccount = components["schemas"]["RevealedAccount"];

/** What editing a block of accounts did, or with `dryRun` would do. */
export type AccountsEdited = components["schemas"]["AccountsEdited"];

export interface AccountsEdit {
  /** The accounts the block was made from, all unsold, all of one package. */
  ids: string[];
  /** The block as the owner left it, one `email|mật khẩu` per line. */
  accounts: string;
  /** Only report what would change. */
  dryRun: boolean;
}

/** What to change about an account in stock; what is left out is kept. */
export interface AccountChange {
  email?: string;
  password?: string;
}

export const ACCOUNTS_PAGE_SIZE = 20;

export type AccountStatusFilter = "all" | "unsold" | "sold";

export interface AccountsQuery {
  /** A package's slug, or null for every package. */
  product: string | null;
  /** An email in full, an order reference, or part of a package or loader. */
  query: string;
  status: AccountStatusFilter;
  /** Counted from 1. */
  page: number;
}

export interface AccountsPage {
  accounts: StockAccount[];
  /** How many accounts each standing has under the search, whichever is shown. */
  counts: Record<AccountStatusFilter, number>;
  /** How many the standing and the search match, across every page. */
  total: number;
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
    delivers_accounts: product.delivers_accounts,
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

  /** Under `queryKey`, so a change to the stock refreshes the accounts too. */
  accountsKey(slug: string) {
    return [...this.queryKey, "accounts", slug] as const;
  }

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
        {
          body: {
            ...fieldsOf(input),
            available: input.stock,
            delivers_accounts: input.delivers_accounts,
          },
        },
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

  /**
   * Puts accounts, one `email|mật khẩu` per line, in stock for a package that
   * hands them out. They go to the server once and are not kept here.
   */
  async loadAccounts(slug: string, accounts: string): Promise<AccountsLoaded> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.POST(
        "/dashboard/telegram/products/{slug}/accounts",
        { body: { accounts }, params: { path: { slug } } },
      );

      if (!data)
        throw serviceError(response, error, "Không nạp được tài khoản.");

      return data;
    });
  }

  /**
   * Accounts across packages, sold and not, with their emails hidden. A
   * collaborator sees the ones they loaded.
   */
  async searchAccounts({
    page,
    product,
    query,
    status,
  }: AccountsQuery): Promise<AccountsPage> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.GET(
        "/dashboard/telegram/accounts",
        {
          params: {
            query: {
              page,
              page_size: ACCOUNTS_PAGE_SIZE,
              product: product ?? undefined,
              q: query.trim() || undefined,
              status: status === "all" ? undefined : status,
            },
          },
        },
      );

      if (!data)
        throw serviceError(response, error, "Không tải được tài khoản.");

      return {
        accounts: data.accounts,
        counts: {
          all: data.counts.all,
          sold: data.counts.sold,
          unsold: data.counts.unsold,
        },
        total: data.total,
      };
    });
  }

  /** The accounts of a package that hands them out; a collaborator sees their own. */
  async accounts(slug: string): Promise<StockAccount[]> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.GET(
        "/dashboard/telegram/products/{slug}/accounts",
        { params: { path: { slug } } },
      );

      if (!data)
        throw serviceError(response, error, "Không tải được tài khoản.");

      return data.accounts;
    });
  }

  /**
   * Gives an account that is not sold a new email, a new password, or both. The
   * server opens it, changes it and seals it again, so neither is read back here.
   * Answers the email as a list shows it.
   */
  async updateAccount(id: string, change: AccountChange): Promise<string> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.PUT(
        "/dashboard/telegram/accounts/{id}",
        { body: change, params: { path: { id } } },
      );

      if (!data)
        throw serviceError(response, error, "Không sửa được tài khoản.");

      return data.email_hint;
    });
  }

  /** Takes an account that is not sold out of stock; answers the count now. */
  async removeAccount(id: string): Promise<number> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.DELETE(
        "/dashboard/telegram/accounts/{id}",
        { params: { path: { id } } },
      );

      if (!data)
        throw serviceError(response, error, "Không xóa được tài khoản.");

      return data.available;
    });
  }

  /**
   * Accounts in the clear, in the order asked, for the owner who proves who they
   * are with their password. Each look is recorded on the server.
   */
  async revealAccounts(
    ids: string[],
    password: string,
  ): Promise<RevealedAccount[]> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.POST(
        "/dashboard/telegram/accounts/reveal",
        { body: { ids, password } },
      );

      if (!data)
        throw serviceError(response, error, "Không xem được tài khoản.");

      return data.accounts;
    });
  }

  /**
   * Brings the accounts of a package that were opened to the block the owner left
   * them as: lines changed are rewritten, lines left out are taken out of stock,
   * lines added are put in. With `dryRun` nothing is written.
   */
  async editAccounts(
    slug: string,
    { accounts, dryRun, ids }: AccountsEdit,
  ): Promise<AccountsEdited> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.PUT(
        "/dashboard/telegram/products/{slug}/accounts",
        {
          body: { accounts, dry_run: dryRun, ids },
          params: { path: { slug } },
        },
      );

      if (!data)
        throw serviceError(response, error, "Không lưu được tài khoản.");

      return data;
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
