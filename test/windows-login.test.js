const test=require('node:test');
const assert=require('node:assert/strict');
const {state,set,migrate,options}=require('../src/windows-login');
const executable='C:\\Program Files\\Ember\\Ember.exe';
function appFixture({registered=false,enabled=false,legacy=false}={}) {
  const writes=[];
  return {writes,getLoginItemSettings({args}){return {openAtLogin:args.length?registered:legacy,executableWillLaunchAtLogin:enabled};},setLoginItemSettings(value){writes.push(value);}};
}
test('Windows login state respects registration and Startup approval',()=>{
  assert.equal(state(appFixture({registered:true,enabled:true}),executable).launchAtLogin,true);
  assert.deepEqual(state(appFixture({registered:true,enabled:false}),executable),{launchAtLogin:false,loginItemStatus:'disabled'});
  assert.equal(state(appFixture(),executable).loginItemStatus,'not-registered');
  assert.deepEqual(options(executable),{path:executable,args:['--ember-login']});
});
test('Windows login registration removes the legacy entry and preserves disabled startup during migration',()=>{
  const app=appFixture({legacy:true,enabled:true});set(app,true,executable);
  assert.deepEqual(app.writes,[{path:executable,args:[],openAtLogin:false},{...options(executable),openAtLogin:true}]);
  const disabled=appFixture({legacy:true,enabled:false});migrate(disabled,executable);assert.deepEqual(disabled.writes,[]);
  const existing=appFixture({registered:true,legacy:true,enabled:true});migrate(existing,executable);assert.deepEqual(existing.writes,[]);
});
