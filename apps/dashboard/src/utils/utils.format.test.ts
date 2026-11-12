import { describe, expect, it } from "vitest";

import type { TelegramProduct } from "@/services/sales/sales-types";

import {
  availableStock,
  formatCompactUsd,
  formatCompactVnd,
  formatDateTime,
  formatDay,
  formatDuration,
  formatTokens,
  formatUsd,
  formatVnd,
  initials,
  productTitle,
  shopDay,
} from "./utils.format";

// Intl puts a no-break space before the currency sign; compare with a plain one.
const plain = (text: string) => text.replace(/\s/g, " ");

const product: TelegramProduct = {
  type: "telegram",
  slug: "claude-pro-1-thang",
  provider: "Claude",
  plan: "Pro 1 tháng",
  variant: null,
  warranty: "WF",
  warranty_note: null,
  guide: null,
  delivers_accounts: false,
  price_vnd: 459_000,
  on_hand: 12,
  reserved: 2,
  hot: false,
  listed: true,
  image_url: "",
};

describe("money", () => {
  it("writes đồng with dot grouping", () => {
    expect(plain(formatVnd(1_890_000))).toBe("1.890.000 ₫");
  });

  it("writes micro-dollars as dollars", () => {
    expect(formatUsd(20_000_000)).toBe("$20.00");
    expect(formatUsd(226_200)).toBe("$0.23");
  });

  it("shortens đồng for axes and tiles", () => {
    expect(formatCompactVnd(850_000)).toBe("850k");
    expect(formatCompactVnd(1_200_000)).toBe("1,2 tr");
    expect(formatCompactVnd(2_000_000)).toBe("2 tr");
    expect(formatCompactVnd(3_400_000_000)).toBe("3,4 tỷ");
    expect(formatCompactVnd(0)).toBe("0");
  });

  it("shortens micro-dollars for axes and tiles", () => {
    expect(formatCompactUsd(500_000)).toBe("$0.5");
    expect(formatCompactUsd(12_000_000)).toBe("$12");
    expect(formatCompactUsd(1_500_000_000)).toBe("$1.5K");
  });

  it("rounds a token count to the unit a person quotes", () => {
    expect(formatTokens(44_208_664)).toBe("44,2M");
    expect(formatTokens(2_000_000_000)).toBe("2B");
    expect(formatTokens(950)).toBe("950");
  });
});

describe("time", () => {
  it("reads a timestamp in shop time, whatever its offset", () => {
    expect(formatDateTime("2026-11-05T14:21:00+07:00")).toBe("14:21 05/11");
    expect(formatDateTime("2026-11-05T07:21:00Z")).toBe("14:21 05/11");
  });

  it("writes a day as dd/MM with a slash", () => {
    expect(formatDay("2026-11-04")).toBe("04/11");
    expect(formatDay("2026-11-05T23:30:00Z")).toBe("06/11");
  });

  it("puts a late-evening UTC instant on the next shop day", () => {
    expect(shopDay("2026-11-05T23:30:00Z")).toBe("2026-11-06");
    expect(shopDay("2026-11-05T16:59:00Z")).toBe("2026-11-05");
  });
});

describe("duration", () => {
  it("uses the largest unit that is at least one", () => {
    expect(formatDuration(0)).toBe("0 phút");
    expect(formatDuration(59)).toBe("59 phút");
    expect(formatDuration(60)).toBe("1 giờ");
    expect(formatDuration(1_439)).toBe("23 giờ");
    expect(formatDuration(1_440)).toBe("1 ngày");
    expect(formatDuration(3_000)).toBe("2 ngày");
  });
});

describe("stock", () => {
  it("names a package like a customer would", () => {
    expect(productTitle(product)).toBe("Pro 1 tháng");
    expect(productTitle({ ...product, variant: "Gia đình" })).toBe(
      "Pro 1 tháng (Gia đình)",
    );
  });

  it("sells what is on hand less what orders hold, never below zero", () => {
    expect(availableStock(product)).toBe(10);
    expect(availableStock({ ...product, on_hand: 1, reserved: 4 })).toBe(0);
  });
});

describe("initials", () => {
  it("takes the last two words", () => {
    expect(initials("Thu Hà")).toBe("TH");
    expect(initials("Nguyễn Văn An")).toBe("VA");
    expect(initials("Minh")).toBe("M");
  });
});
