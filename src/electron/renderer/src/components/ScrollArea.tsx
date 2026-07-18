import type { EventListeners, PartialOptions } from "overlayscrollbars";
import { OverlayScrollbarsComponent } from "overlayscrollbars-react";
import type { ComponentPropsWithoutRef } from "react";
import "./ScrollArea.scss";

// One place for the scrollbar behavior so every pane feels identical on every OS: a thin
// macOS-style overlay bar that shows while scrolling and fades out ~0.8s after it stops.
// The look (size, colors) lives in the .os-theme-app block in ScrollArea.scss.
const OPTIONS: PartialOptions = {
  scrollbars: {
    theme: "os-theme-app",
    autoHide: "scroll",
    autoHideDelay: 800,
    clickScroll: true,
  },
};

// Custom-scrollbar container. OverlayScrollbars moves the children into an inner viewport
// element, so the host's own scroll position/events are inert — subscribe through `events`
// (see LogView) instead of onScroll.
export function ScrollArea({
  events,
  ...rest
}: ComponentPropsWithoutRef<"div"> & { events?: EventListeners }) {
  return <OverlayScrollbarsComponent options={OPTIONS} events={events} {...rest} />;
}
