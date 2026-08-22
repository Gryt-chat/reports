import "@fontsource-variable/geist";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@gryt/ui/styles.css";
import "./styles/tokens.css";
import "./styles/app.css";

import { GrytProvider } from "@gryt/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("No #root to mount on");

createRoot(root).render(
  <StrictMode>
    {/* The dashboard has no theme of its own — it wears whatever GrytProvider
        is set to, which is the same rule the library's own docs follow. */}
    <GrytProvider>
      <BrowserRouter basename="/admin">
        <App />
      </BrowserRouter>
    </GrytProvider>
  </StrictMode>,
);
