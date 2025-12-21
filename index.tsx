import React from "react";
import { createRoot } from "react-dom/client";
import { DeepDiveGame } from "./src/Game";

// Add global styles for animations
const styleSheet = document.createElement("style");
styleSheet.innerText = `
@keyframes pulse {
  0% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.7; transform: scale(0.95); }
  100% { opacity: 1; transform: scale(1); }
}
`;
document.head.appendChild(styleSheet);

const root = createRoot(document.getElementById("root")!);
root.render(<DeepDiveGame />);
