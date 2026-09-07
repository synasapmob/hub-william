import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useCatalogCanvasViewport } from "./catalog-canvas-viewport";

interface ViewportHarnessProps {
  locked: boolean;
}

function ViewportHarness({ locked }: ViewportHarnessProps) {
  const { pan, surface } = useCatalogCanvasViewport({ locked });

  return (
    <section {...surface}>
      <output>{`${pan.x},${pan.y}`}</output>
    </section>
  );
}

describe("useCatalogCanvasViewport", () => {
  it("does not drag the canvas while its sheet is open", () => {
    const { container, rerender } = render(<ViewportHarness locked={false} />);
    const surface = container.querySelector("section")!;
    const position = container.querySelector("output")!;

    fireEvent.mouseDown(surface, { clientX: 100, clientY: 140 });
    fireEvent.mouseMove(surface, { clientX: 140, clientY: 180 });
    expect(position).toHaveTextContent("100,180");

    rerender(<ViewportHarness locked />);
    fireEvent.mouseDown(surface, { clientX: 200, clientY: 240 });
    fireEvent.mouseMove(surface, { clientX: 260, clientY: 300 });
    expect(position).toHaveTextContent("100,180");
  });

  it("does not pan from a wheel while its sheet is open", () => {
    const { container, rerender } = render(<ViewportHarness locked={false} />);
    const surface = container.querySelector("section")!;
    const position = container.querySelector("output")!;

    fireEvent.wheel(surface, { deltaX: 10, deltaY: 20 });
    expect(position).toHaveTextContent("50,120");

    rerender(<ViewportHarness locked />);
    fireEvent.wheel(surface, { deltaX: 20, deltaY: 40 });
    expect(position).toHaveTextContent("50,120");
  });
});
