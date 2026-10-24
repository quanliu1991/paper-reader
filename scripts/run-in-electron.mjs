// 用 Electron 以 Node 模式（ELECTRON_RUN_AS_NODE）执行脚本
import { spawn } from 'child_process';
import path from 'path';

const electronExe = path.resolve('node_modules/electron/dist/electron.exe');
const child = spawn(electronExe, [process.argv[2]], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
});
child.on('exit', c => process.exit(c ?? 0));
