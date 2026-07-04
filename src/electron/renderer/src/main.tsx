import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// CSS order matters: library CSS, then the global base, then App — whose components each
// import their own .scss, so component styles land after the base rules they override.
import "overlayscrollbars/overlayscrollbars.css";
import "./global.scss";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
