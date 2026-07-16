import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// CSS order matters: library CSS, then the global base, then App — whose components each
// import their own .scss, so component styles land after the base rules they override.
import "overlayscrollbars/overlayscrollbars.css";
import "./global.scss";
import App from "./App";

// macOS runs with a hidden native title bar (titleBarStyle: hiddenInset), so the header must
// leave room for the traffic lights and act as the window drag region — both scoped to this class.
document.body.classList.toggle("is-mac", navigator.platform.startsWith("Mac"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
