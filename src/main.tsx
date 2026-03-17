import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "xterm/css/xterm.css";
import "@carrot-kpi/switzer-font/latin.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
