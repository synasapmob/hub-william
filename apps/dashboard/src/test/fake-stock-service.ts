import { ServiceError } from "@/services/api/api-client";
import type { TelegramProduct } from "@/services/sales/sales-types";
import type {
  AccountChange,
  AccountsEdit,
  AccountsEdited,
  AccountsLoaded,
  AccountsPage,
  AccountsQuery,
  Announced,
  NewStock,
  RevealedAccount,
  StockAccount,
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
    warranty_note: null,
    delivers_accounts: false,
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
    warranty_note: null,
    delivers_accounts: false,
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
    warranty_note: null,
    delivers_accounts: false,
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
    warranty_note: null,
    delivers_accounts: false,
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
    warranty_note: null,
    delivers_accounts: true,
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
    warranty_note: "Không bảo hành đổi trả",
    delivers_accounts: false,
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
    warranty_note: null,
    delivers_accounts: false,
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
/** The accounts the fake holds, as the API lists them, with the password each opens to. */
const ACCOUNT_FIXTURE: { account: StockAccount; slug: string; line: string }[] =
  [
    {
      slug: "claude-max-5x-1-thang",
      line: "owner@example.com|right-secret",
      account: {
        email_hint: "o***@example.com",
        id: "account-unsold",
        loaded_at: "2026-11-08T09:00:00Z",
        loaded_by: "minhanh",
        order_reference: null,
        product_slug: "claude-max-5x-1-thang",
        product_title: "Max 5x 1 tháng",
        sold_at: null,
      },
    },
    {
      slug: "claude-max-5x-1-thang",
      line: "buyer@example.com|already-sent",
      account: {
        email_hint: "b***@example.com",
        id: "account-sold",
        loaded_at: "2026-11-08T08:00:00Z",
        loaded_by: "ducthinh",
        order_reference: "ABC123DEF456",
        product_slug: "claude-max-5x-1-thang",
        product_title: "Max 5x 1 tháng",
        sold_at: "2026-11-08T09:30:00Z",
      },
    },
  ];

// The page size of the real service, which this file cannot import.
const FAKE_PAGE_SIZE = 20;

/** The owner's password in tests. */
export const FAKE_OWNER_PASSWORD = "the-owners-password";

let accountRows = structuredClone(ACCOUNT_FIXTURE);

export function resetFakeStock() {
  products = structuredClone(FIXTURE);
  accountRows = structuredClone(ACCOUNT_FIXTURE);
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

// The email hidden but for its first letter and its domain, as the API shows it.
function hintOf(email: string) {
  const head = email.slice(0, 1);
  const at = email.indexOf("@");

  return at < 0 ? `${head}***` : `${head}***${email.slice(at)}`;
}

const emailOf = (line: string) => line.slice(0, line.indexOf("|"));

// What makes two lines the same account: the email in lower case, the password as is.
const identityOf = (line: string) =>
  `${emailOf(line).trim().toLowerCase()}|${line.slice(line.indexOf("|") + 1).trim()}`;

const normalised = (raw: string) => {
  const [email, ...rest] = raw.split("|");

  return `${email.trim()}|${rest.join("|").trim()}`;
};

const refusal = (message: string) =>
  new ServiceError(message, 422, "validation_error");

let nextAccount = 1;

// An account just loaded, as the API would list it.
function newRow(product: TelegramProduct, line: string) {
  return {
    account: {
      email_hint: hintOf(emailOf(line)),
      id: `account-loaded-${nextAccount++}`,
      loaded_at: "2026-11-09T09:00:00Z",
      loaded_by: "admin",
      order_reference: null,
      product_slug: product.slug,
      product_title: `${product.plan}${product.variant ? ` (${product.variant})` : ""}`,
      sold_at: null,
    } satisfies StockAccount,
    line,
    slug: product.slug,
  };
}

/**
 * The stock service as the server would behave, kept in memory: the same refusals
 * (a product that exists, a count below zero) and the same answers. A test
 * replaces one method with a spy to see what was asked, or to make it fail.
 */
export const fakeStockService = {
  queryKey: ["dashboard", "stock"] as const,

  accountsKey(slug: string) {
    return [...this.queryKey, "accounts", slug] as const;
  },

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
    const { delivers_accounts: delivers, ...fields } = input;
    const unsold = accountRows.filter(
      (row) => row.slug === slug && !row.account.order_reference,
    ).length;

    // As the server does: turning it off needs no account left to sell, and
    // either way the count becomes the accounts not sold, which is none for a
    // package that never held any. A refusal changes nothing.
    if (product.delivers_accounts && !delivers && unsold > 0)
      throw refusal(
        "This package still holds accounts that are not sold. Take them out first, then turn this off.",
      );

    if (product.delivers_accounts !== delivers) {
      product.delivers_accounts = delivers;
      product.on_hand = delivers ? unsold : 0;
    }

    Object.assign(product, fields);

    return structuredClone(product);
  },

  async loadAccounts(slug: string, accounts: string): Promise<AccountsLoaded> {
    const product = find(slug);

    if (!product.delivers_accounts)
      throw new ServiceError(
        "That package does not hand out accounts.",
        422,
        "validation_error",
      );

    let added = 0;
    let duplicates = 0;

    for (const raw of accounts.split("\n")) {
      if (raw.trim() === "") continue;

      const line = normalised(raw);

      // A line is an account whatever its email; only the same line is a repeat.
      if (
        accountRows.some(
          (row) =>
            row.slug === slug && identityOf(row.line) === identityOf(line),
        )
      ) {
        duplicates += 1;

        continue;
      }

      accountRows.unshift(newRow(product, line));
      added += 1;
    }

    product.on_hand += added;

    return { added, available: product.on_hand, duplicates };
  },

  async accounts(slug: string): Promise<StockAccount[]> {
    return structuredClone(
      accountRows.filter((row) => row.slug === slug).map((row) => row.account),
    );
  },

  async searchAccounts({
    page,
    product,
    query,
    status,
  }: AccountsQuery): Promise<AccountsPage> {
    const text = query.trim().toLowerCase();
    // Matches what the API matches: an email in full, an order, a package, a loader.
    const matching = accountRows.filter(
      ({ account, line, slug }) =>
        (product === null || slug === product) &&
        (text === "" ||
          line.split("|")[0].toLowerCase() === text ||
          account.order_reference?.toLowerCase().includes(text) ||
          account.loaded_by?.toLowerCase().includes(text) ||
          account.product_title.toLowerCase().includes(text)),
    );
    const sold = matching.filter(
      ({ account }) => account.order_reference,
    ).length;
    const shown = matching.filter(
      ({ account }) =>
        status === "all" || (status === "sold") === !!account.order_reference,
    );

    return structuredClone({
      accounts: shown
        .slice((page - 1) * FAKE_PAGE_SIZE, page * FAKE_PAGE_SIZE)
        .map(({ account }) => account),
      counts: {
        all: matching.length,
        sold,
        unsold: matching.length - sold,
      },
      total: shown.length,
    });
  },

  async updateAccount(id: string, change: AccountChange): Promise<string> {
    const row = accountRows.find((candidate) => candidate.account.id === id);

    if (!row || row.account.order_reference)
      throw new ServiceError(
        "The requested resource was not found.",
        404,
        "not_found",
      );

    const email = change.email?.trim() || emailOf(row.line);
    const password =
      change.password?.trim() || row.line.slice(row.line.indexOf("|") + 1);
    const line = `${email}|${password}`;

    if (!change.email?.trim() && !change.password?.trim())
      throw refusal("Give a new email, a new password, or both.");

    if (line === row.line)
      throw refusal("That is the account as it already is.");

    if (
      accountRows.some(
        (other) =>
          other !== row &&
          other.slug === row.slug &&
          identityOf(other.line) === identityOf(line),
      )
    )
      throw refusal("That account is already in stock for this package.");

    row.line = line;
    row.account.email_hint = hintOf(email);

    return row.account.email_hint;
  },

  async removeAccount(id: string): Promise<number> {
    const row = accountRows.find((candidate) => candidate.account.id === id);

    if (!row || row.account.order_reference)
      throw new ServiceError(
        "The requested resource was not found.",
        404,
        "not_found",
      );

    accountRows = accountRows.filter((candidate) => candidate !== row);
    find(row.slug).on_hand -= 1;

    return find(row.slug).on_hand;
  },

  async revealAccounts(
    ids: string[],
    password: string,
  ): Promise<RevealedAccount[]> {
    if (password !== FAKE_OWNER_PASSWORD)
      throw refusal("That password is not right.");

    if (ids.length === 0) throw refusal("Choose at least one account.");

    return ids.map((id) => {
      const row = accountRows.find((candidate) => candidate.account.id === id);

      if (!row)
        throw new ServiceError(
          "The requested resource was not found.",
          404,
          "not_found",
        );

      return { account: row.line, id };
    });
  },

  /** Does to the accounts what the server does to a block, in the same order of choices. */
  async editAccounts(
    slug: string,
    { accounts, dryRun, ids }: AccountsEdit,
  ): Promise<AccountsEdited> {
    const product = find(slug);
    const rows = ids.map((id) =>
      accountRows.find((candidate) => candidate.account.id === id),
    );

    if (ids.length === 0) throw refusal("Choose at least one account.");

    if (
      rows.some(
        (row) => !row || row.slug !== slug || row.account.order_reference,
      )
    )
      throw refusal(
        "Some of these accounts were sold or removed while you were editing. Open them again.",
      );

    const opened = rows as NonNullable<(typeof rows)[number]>[];
    const lines = accounts
      .split("\n")
      .filter((raw) => raw.trim() !== "")
      .map(normalised);

    // A line still there stays as it is.
    const waiting = new Map<string, number[]>();

    opened.forEach((row, index) => {
      const identity = identityOf(row.line);

      waiting.set(identity, [...(waiting.get(identity) ?? []), index]);
    });

    const kept = new Set<number>();
    const fresh: string[] = [];

    for (const line of lines) {
      const index = waiting.get(identityOf(line))?.shift();

      if (index === undefined) fresh.push(line);
      else kept.add(index);
    }

    // A line gone is rewritten as the new line of the same email, then as the
    // next new line; what finds no partner is taken out, or put in.
    const pairs: [number, number][] = [];
    const usedFresh = new Set<number>();
    const unpaired: number[] = [];

    opened.forEach((row, index) => {
      if (kept.has(index)) return;

      const partner = fresh.findIndex(
        (line, f) =>
          !usedFresh.has(f) &&
          emailOf(line).trim().toLowerCase() ===
            emailOf(row.line).trim().toLowerCase(),
      );

      if (partner < 0) unpaired.push(index);
      else {
        usedFresh.add(partner);
        pairs.push([index, partner]);
      }
    });

    const spare = fresh.map((_, f) => f).filter((f) => !usedFresh.has(f));
    const removals: (typeof opened)[number][] = [];

    for (const index of unpaired) {
      const partner = spare.shift();

      if (partner === undefined) removals.push(opened[index]);
      else pairs.push([index, partner]);
    }

    // What the package holds apart from the accounts being rewritten.
    const held = new Set(
      [...kept].map((index) => identityOf(opened[index].line)),
    );

    for (const row of accountRows)
      if (row.slug === slug && !opened.includes(row))
        held.add(identityOf(row.line));

    let duplicates = 0;
    const rewrites: [(typeof opened)[number], string][] = [];
    const insertions: string[] = [];

    for (const [index, f] of pairs) {
      if (held.has(identityOf(fresh[f]))) {
        duplicates += 1;
        removals.push(opened[index]);
      } else {
        held.add(identityOf(fresh[f]));
        rewrites.push([opened[index], fresh[f]]);
      }
    }

    for (const f of spare) {
      if (held.has(identityOf(fresh[f]))) duplicates += 1;
      else {
        held.add(identityOf(fresh[f]));
        insertions.push(fresh[f]);
      }
    }

    const result = {
      added: insertions.length,
      changed: rewrites.length,
      duplicates,
      removed: removals.length,
    };

    if (dryRun)
      return {
        ...result,
        available: Math.max(product.on_hand - result.removed + result.added, 0),
      };

    accountRows = accountRows.filter((row) => !removals.includes(row));

    for (const [row, line] of rewrites) {
      row.line = line;
      row.account.email_hint = hintOf(emailOf(line));
    }

    for (const line of insertions) accountRows.unshift(newRow(product, line));

    product.on_hand = Math.max(
      product.on_hand - result.removed + result.added,
      0,
    );

    return { ...result, available: product.on_hand };
  },

  async changeStock(slug: string, delta: number): Promise<TelegramProduct> {
    const product = find(slug);

    if (product.delivers_accounts)
      throw new ServiceError(
        "That package hands out accounts, so its count follows them.",
        422,
        "validation_error",
      );

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
