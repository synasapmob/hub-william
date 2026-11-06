import "vitest";
import type matchers from "@testing-library/jest-dom/matchers";

declare module "vitest" {
  // Module augmentation requires an interface even though all members are inherited.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Matchers<T = unknown> extends matchers.TestingLibraryMatchers<
    unknown,
    T
  > {}
}
