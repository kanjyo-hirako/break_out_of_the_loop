// 用官方校验器验证 market/index.json（发布前必跑）。
// DSH 官方约定："index generators validate their output with it before publishing"。
import { readFileSync } from "node:fs";
import { parseMarketIndex, marketInstallTarget } from "@deepseek-ai/dsh-plugin-market-index";

const indexPath = new URL("../market/index.json", import.meta.url);
const document = JSON.parse(readFileSync(indexPath, "utf8"));

try {
  const index = parseMarketIndex(document, "https://example.invalid/index.json");
  console.log(`market/index.json OK — ${index.plugins.length} plugin(s), index "${typeof index.title === "string" ? index.title : index.title.en}"`);
  for (const plugin of index.plugins) {
    for (const version of plugin.versions) {
      const target = marketInstallTarget(plugin.name, version);
      console.log(`  ${plugin.name}@${version.version} -> ${target.spec}${target.registry ? ` (registry: ${target.registry})` : ""}`);
    }
  }
  process.exit(0);
} catch (error) {
  console.error(`market/index.json INVALID at ${error.path ?? "?"}: ${error.reason ?? error.message}`);
  process.exit(1);
}
