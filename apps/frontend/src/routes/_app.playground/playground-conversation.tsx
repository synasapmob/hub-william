import { useEffect, useRef, type ReactNode } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { tv } from "tailwind-variants";
import { Button } from "@/components/ui/button";

interface PlaygroundConversationProps {
  zoomed: boolean;
  onExitZoom: () => void;
  children: ReactNode;
}

interface PlaygroundZoomButtonProps {
  zoomed: boolean;
  onToggle: () => void;
}

const conversation = tv({
  base: "space-y-5",
  variants: {
    zoomed: {
      true: "fixed inset-0 z-40 grid grid-rows-[auto_1fr] space-y-0 overflow-y-auto overscroll-contain bg-white [&>section]:overflow-visible [&>section]:rounded-none [&>section]:border-0 [&>section>header]:sticky [&>section>header]:top-0 [&>section>header]:z-10 [&>section>header]:bg-white",
    },
  },
});

export function PlaygroundZoomButton({
  zoomed,
  onToggle,
}: PlaygroundZoomButtonProps) {
  const Icon = zoomed ? Minimize2 : Maximize2;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="min-h-10"
      onClick={onToggle}
    >
      <Icon aria-hidden="true" className="size-4" />
      {zoomed ? "Exit Zoom" : "Zoom Screen"}
    </Button>
  );
}

export default function PlaygroundConversation({
  zoomed,
  onExitZoom,
  children,
}: PlaygroundConversationProps) {
  const screen = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = screen.current;
    if (!zoomed || !node) return;
    const previousFocus = document.activeElement;
    const overflow = document.body.style.overflow;
    const background = new Map<HTMLElement, boolean>();
    // Preserve the conversation DOM and active media; only isolate its siblings.
    let current: HTMLElement | null = node;
    while (current?.parentElement) {
      for (const sibling of current.parentElement.children)
        if (sibling !== current && sibling instanceof HTMLElement) {
          background.set(sibling, sibling.inert);
          sibling.inert = true;
        }
      if (current.parentElement === document.body) break;
      current = current.parentElement;
    }
    document.body.style.overflow = "hidden";
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector(
          '[role="dialog"][data-state="open"], [role="listbox"][data-state="open"], [data-radix-popper-content-wrapper]',
        )
      ) {
        event.preventDefault();
        onExitZoom();
      }
    };
    // Inspect portals before Radix handles Escape and removes them from the DOM.
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("keydown", escape, true);
      document.body.style.overflow = overflow;
      for (const [element, inert] of background) element.inert = inert;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
    };
  }, [zoomed, onExitZoom]);

  return (
    <div ref={screen} className={conversation({ zoomed })}>
      {children}
    </div>
  );
}
