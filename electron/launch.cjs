// Starts the desktop app. Clears ELECTRON_RUN_AS_NODE first: terminals inside VS Code (itself Electron) set it,
// which would make Electron behave like plain Node and never open a window.
const { spawn } = require('child_process');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [require('path').join(__dirname, '..')], { stdio: 'inherit', env });
child.on('exit', code => process.exit(code ?? 0));
