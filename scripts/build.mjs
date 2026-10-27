// 构建入口：委托给 tsc（tsconfig.build.json）。
// 刻意不依赖打包器：产物为标准多文件 ESM（lib/），相对导入由
// `rewriteRelativeImportExtensions` 从 .ts 改写为 .js。
// 运行时依赖 @deepseek-ai/schemastery 保持外部依赖（schema 对象由宿主
// 加载器解释，打包第二份会破坏 Schema 身份检查）。
import { execFileSync } from "node:child_process";

execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], {
  stdio: "inherit"
});

console.log("build ok: lib/");
