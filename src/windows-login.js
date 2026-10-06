const LOGIN_FLAG = '--ember-login';
function options(executable = process.execPath) {
  return { path: executable, args: [LOGIN_FLAG] };
}
function state(app, executable = process.execPath) {
  const item = app.getLoginItemSettings(options(executable));
  const enabled = Boolean(item.openAtLogin && item.executableWillLaunchAtLogin);
  return { launchAtLogin: enabled, loginItemStatus: enabled ? 'enabled' : item.openAtLogin ? 'disabled' : 'not-registered' };
}
function set(app, enabled, executable = process.execPath) {
  // Remove the former argument-free entry before replacing it, avoiding duplicate launches.
  if (app.getLoginItemSettings({path:executable,args:[]}).openAtLogin) {
    app.setLoginItemSettings({path:executable,args:[],openAtLogin:false});
  }
  app.setLoginItemSettings({...options(executable),openAtLogin:Boolean(enabled)});
}
function migrate(app, executable = process.execPath) {
  const current = app.getLoginItemSettings(options(executable));
  const legacy = app.getLoginItemSettings({path:executable,args:[]});
  // Respect a startup entry disabled by Windows/Task Manager.
  if (!current.openAtLogin && legacy.openAtLogin && legacy.executableWillLaunchAtLogin) set(app,true,executable);
}
module.exports = { LOGIN_FLAG, options, state, set, migrate };
