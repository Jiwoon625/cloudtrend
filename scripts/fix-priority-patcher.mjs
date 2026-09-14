import fs from "node:fs";

const path = "scripts/apply-priority-score-rotation-5pt.mjs";
let text = fs.readFileSync(path, "utf8");
if (!text.includes("${")) throw new Error("No template expressions found to escape");
text = text.replaceAll("${", "\\${");
fs.writeFileSync(path, text);
console.log("escaped nested template expressions");
