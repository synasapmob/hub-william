import { describe, expect, it } from "vitest";

import { cn } from "@/utils/utils.class-names";

describe("cn", () => {
  it("merges conflicting Tailwind classes", () => {
    expect(cn("px-2", "px-4", { hidden: false })).toBe("px-4");
  });
});
