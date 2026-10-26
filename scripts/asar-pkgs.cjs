// asar 体积分析 v2：node_modules 内每个包占多少（按文件数找大头）
const asar = require('@electron/asar');
const list = asar.listPackage('release/win-unpacked/resources/app.asar');
const pkgs = {};
for (const f of list) {
  const m = f.match(/^[/\\]node_modules[/\\](@[^/\\]+[/\\][^/\\]+|[^/\\]+)/);
  if (m) pkgs[m[1]] = (pkgs[m[1]] ?? 0) + 1;
}
const top = Object.entries(pkgs).sort((x, y) => y[1] - x[1]).slice(0, 15);
for (const [k, v] of top) console.log(String(v).padStart(6), k);
