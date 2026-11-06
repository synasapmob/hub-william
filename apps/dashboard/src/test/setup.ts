import * as matchers from "@testing-library/jest-dom/matchers";

import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, expect } from "vitest";

expect.extend(matchers);

// Node's native localStorage shadows jsdom in newer runtimes. Exercise real
// browser Storage semantics in tests, without enabling Node's filesystem store.
interface BrowserTestEnvironment {
  jsdom: { window: Window };
}
const originalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: (globalThis as unknown as BrowserTestEnvironment).jsdom.window
    .localStorage,
});
afterAll(() => {
  if (originalStorage)
    Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

// Capture the real timer before individual tests install fake timers.
const scheduleCleanup = globalThis.setTimeout.bind(globalThis);

// Radix Select uses pointer capture, which jsdom does not implement.
if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
}

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

afterEach(async () => {
  cleanup();
  // Radix defers unmount autofocus to a zero-delay timer. Finish it before
  // Vitest tears down this jsdom realm and replaces its Event constructors.
  await new Promise<void>((resolve) => scheduleCleanup(resolve, 0));
});
