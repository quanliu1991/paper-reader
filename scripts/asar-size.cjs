// 检查 app.asar 体积构成：顶层目录各占多少
const asar = require('@electron/asar');const list = asar.listPackage('release/win-unpacked/resources/app.asar');
const top = {};
for (const f of list) {
  const k = f.replace(/^[/\\]+/, '').split(/[/\\]/)[0];
  top[k] = (top[k] ?? 0) + 1;
}
console.log(Object.entries(top).sort((x, y) => y[1] - x[1]).slice(0, 12));
