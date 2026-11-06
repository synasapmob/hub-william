import { ServiceError } from "@/services/api/api-client";
import type { TelegramProduct } from "@/services/sales/sales-types";
import type {
  Announced,
  NewStock,
  StockInput,
} from "@/services/stock/stock-service";
import slugify from "@/utils/utils.slug";

// The shop a test starts from: seven packages, shaped like the API's answer.
const FIXTURE: TelegramProduct[] = [
  {
    type: "telegram",
    slug: "chatgpt-plus-1-thang-full",
    provider: "ChatGPT",
    plan: "Plus 1 tháng",
    variant: "Full",
    warranty: "WF",
    price_vnd: 189_000,
    on_hand: 24,
    reserved: 3,
    hot: true,
    listed: true,
    image_url: "https://picsum.photos/400/300?random=1",
  },
  {
    type: "telegram",
    slug: "chatgpt-plus-1-thang-7-ngay",
    provider: "ChatGPT",
    plan: "Plus 1 tháng",
    variant: "7 ngày",
    warranty: "W7D",
    price_vnd: 159_000,
    on_hand: 40,
    reserved: 0,
    hot: false,
    listed: true,
    image_url: "https://picsum.photos/400/300?random=2",
  },
  {
    type: "telegram",
    slug: "chatgpt-pro-1-thang",
    provider: "ChatGPT",
    plan: "Pro 1 tháng",
    variant: null,
    warranty: "WF",
    price_vnd: 1_890_000,
    on_hand: 5,
    reserved: 1,
    hot: false,
    listed: true,
    image_url: "https://picsum.photos/400/300?random=3",
  },
  {
    type: "telegram",
    slug: "claude-pro-1-thang",
    provider: "Claude",
    plan: "Pro 1 tháng",
    variant: null,
    warranty: "WF",
    price_vnd: 459_000,
    on_hand: 12,
    reserved: 2,
    hot: true,
    listed: true,
    image_url: "https://picsum.photos/400/300?random=4",
  },
  {
    type: "telegram",
    slug: "claude-max-5x-1-thang",
    provider: "Claude",
    plan: "Max 5x 1 tháng",
    variant: null,
    warranty: "WF",
    price_vnd: 2_390_000,
    on_hand: 4,
    reserved: 4,
    hot: false,
    listed: true,
    image_url: "",
  },
  {
    type: "telegram",
    slug: "gemini-advanced-1-thang-gia-dinh",
    provider: "Gemini",
    plan: "Advanced 1 tháng",
    variant: "Gia đình",
    warranty: "NW",
    price_vnd: 79_000,
    on_hand: 60,
    reserved: 5,
    hot: false,
    listed: true,
    image_url: "https://picsum.photos/400/300?random=6",
  },
  {
    type: "telegram",
    slug: "chatgpt-go-1-thang",
    provider: "ChatGPT",
    plan: "Go 1 tháng",
    variant: null,
    warranty: "NW",
    price_vnd: 49_000,
    on_hand: 80,
    reserved: 6,
    hot: false,
    listed: false,
    image_url: "https://picsum.photos/400/300?random=8",
  },
];

let products: TelegramProduct[] = structuredClone(FIXTURE);

/** The packages a test starts from, to make others like them. */
export function fakeStockServiceProducts() {
  return structuredClone(FIXTURE);
}

/** Puts the shop back as every test starts. */
export function resetFakeStock() {
  products = structuredClone(FIXTURE);
}

function find(slug: string) {
  const product = products.find((candidate) => candidate.slug === slug);

  if (!product)
    throw new ServiceError(
      "The requested resource was not found.",
      404,
      "not_found",
    );

  return product;
}

/**
 * The stock service as the server would behave, kept in memory: the same refusals
 * (a product that exists, a count below zero) and the same answers. A test
 * replaces one method with a spy to see what was asked, or to make it fail.
 */
export const fakeStockService = {
  queryKey: ["dashboard", "stock"] as const,

  async list(): Promise<TelegramProduct[]> {
    return structuredClone(products);
  },

  async create(input: NewStock): Promise<TelegramProduct> {
    const slug = slugify(input.provider, input.plan, input.variant);

    if (products.some((product) => product.slug === slug))
      throw new ServiceError(
        "That product already exists.",
        409,
        "already_exists",
      );

    const { stock, ...fields } = input;
    const created: TelegramProduct = {
      ...fields,
      type: "telegram",
      slug,
      on_hand: stock,
      reserved: 0,
    };

    products = [...products, created];

    return structuredClone(created);
  },

  async update(slug: string, input: StockInput): Promise<TelegramProduct> {
    const product = find(slug);

    Object.assign(product, input);

    return structuredClone(product);
  },

  async changeStock(slug: string, delta: number): Promise<TelegramProduct> {
    const product = find(slug);

    if (product.on_hand + delta < 0)
      throw new ServiceError(
        "That takes out more units than there are in stock.",
        422,
        "validation_error",
      );

    product.on_hand += delta;

    return structuredClone(product);
  },

  async remove(slug: string): Promise<void> {
    find(slug);
    products = products.filter((product) => product.slug !== slug);
  },

  /** The bot reaches the channel and 12 chats, which is all a test needs to know. */
  async announce(text: string): Promise<Announced> {
    if (text.trim() === "")
      throw new ServiceError(
        "A message cannot be empty.",
        422,
        "validation_error",
      );

    return { audience: 12, channel: true };
  },
};
