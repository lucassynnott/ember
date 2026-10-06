const test = require('node:test');
const assert = require('node:assert/strict');
const {WindowsCalendarReader,normalizeEvent,callLink} = require('../src/windows-calendar');
const start = Date.parse('2026-10-06T10:00:00Z');
const finish = start + 3600000;
test('calendar connection requires an explicit provider and verifies the returned account', async () => {
  let accounts=[]; const calls=[];
  const cli={prepare:async()=> 'cli',link:async(...args)=>{calls.push(args[3]);return {id:'chosen'};},proxy:async(_binary,url,_options,id)=>{assert.equal(id,'chosen');assert.match(url,/calendars\/primary/);return {id:'lucas@example.com'};}};
  const reader=new WindowsCalendarReader({cli,getAccounts:()=>accounts,saveAccounts:async value=>{accounts=value;}});
  await assert.rejects(reader.request(),/Choose/);
  await reader.request('googlecalendar');
  assert.deepEqual(calls,['googlecalendar']);
  assert.deepEqual(accounts,[{provider:'googlecalendar',accountId:'chosen',email:'lucas@example.com'}]);
});
test('calendar event normalization preserves recurrence, attendee responses and UTC', () => {
  const event=normalizeEvent({id:'event',subject:'Planning',type:'occurrence',start:{dateTime:'2026-10-06T10:00:00',timeZone:'UTC'},end:{dateTime:'2026-10-06T11:00:00',timeZone:'UTC'},onlineMeeting:{joinUrl:'https://teams.microsoft.com/l/meetup-join/abc'},attendees:[{emailAddress:{name:'Lucas',address:'lucas@example.com'},status:{response:'declined'}}]},'outlook',{id:'work',name:'Work'},'Lucas@example.com');
  assert.equal(event.start,start);assert.equal(event.recurring,true);assert.equal(event.attendees[0].me,true);assert.equal(event.attendees[0].declined,true);
  assert.equal(normalizeEvent({isCancelled:true},'outlook',{}),null);
  assert.equal(callLink('https://meet.google.com.evil.test/a'),null);
  assert.throws(()=>normalizeEvent({start:{dateTime:'2026-10-06T10:00:00',timeZone:'Pacific Standard Time'},end:{dateTime:'2026-10-06T11:00:00'}},'outlook',{}),/non-UTC/);
});
test('Google pages retain query bounds and the exact configured account',async()=>{
  const routes=[];
  const cli={binary:async()=> 'cli',proxy:async(_binary,url,_options,id)=>{
    assert.equal(id,'personal');routes.push(new URL(url));
    if(url.includes('calendarList'))return {items:[{id:'primary',summary:'Personal'}]};
    if(new URL(url).searchParams.has('pageToken'))return {items:[{id:'cancelled',status:'cancelled'}]};
    return {items:[{id:'meeting',summary:'Review',start:{dateTime:new Date(start).toISOString()},end:{dateTime:new Date(finish).toISOString()}}],nextPageToken:'second page'};
  }};
  const reader=new WindowsCalendarReader({cli,getAccounts:()=>[{provider:'googlecalendar',accountId:'personal',email:'me@example.com'}]});
  const events=await reader.events(start,finish);assert.equal(events.length,1);
  assert.equal(routes[2].searchParams.get('timeMin'),new Date(start).toISOString());assert.equal(routes[2].searchParams.get('singleEvents'),'true');assert.equal(routes[2].searchParams.get('pageToken'),'second page');
});
test('foreign pagination is rejected before forwarding credentials',async()=>{
  let calls=0;
  const reader=new WindowsCalendarReader({cli:{binary:async()=> 'cli',proxy:async()=>{calls++;return {value:[],'@odata.nextLink':'https://attacker.test/steal'};}},getAccounts:()=>[{provider:'outlook',accountId:'work'}]});
  await assert.rejects(reader.events(start,finish),/unexpected address/);assert.equal(calls,1);
});
test('calendar account selection survives settings persistence and reaches runtime', async()=>{
  const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
  const {SettingsStore}=require('../src/settings-store');const {getSettings}=require('../src/config');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ember-calendar-settings-'));
  try {
    const options={filePath:path.join(directory,'settings.json'),safeStorage:{isEncryptionAvailable:()=>false},defaults:{}};
    const store=await new SettingsStore(options).load();
    const account={provider:'outlook',accountId:'selected-work',email:'work@example.com'};
    await store.save({calendarAccounts:[account,{provider:'unknown',accountId:'bad',email:'bad'}],calendarEnabled:true});
    const reloaded=await new SettingsStore(options).load();
    assert.deepEqual(getSettings(reloaded.runtime()).calendarAccounts,[account]);
    assert.deepEqual(reloaded.publicState().calendarAccounts,[account]);
  }finally {await fs.rm(directory,{recursive:true,force:true});}
});
test('Microsoft To Do selection routes create and completion to the selected account and list',async()=>{
  const accounts=[{provider:'outlook',accountId:'personal',email:'personal@example.com'},{provider:'outlook',accountId:'work',email:'work@example.com'}];
  const writes=[];
  const reader=new WindowsCalendarReader({getAccounts:()=>accounts,cli:{binary:async()=> 'cli',connections:async()=>accounts.map(account=>({id:account.accountId,status:'ACTIVE'})),execute:async(_binary,slug,args,id)=>{
    if(slug==='OUTLOOK_LIST_TO_DO_LISTS')return {successful:true,data:{value:[{id:'same-list-id',displayName:'Tasks'}]}};
    writes.push({slug,args,id});
    return {successful:true,data:{id:'task-1',status:args.status || 'notStarted'}};
  }}});
  const {lists,defaultId}=await reader.reminderLists();assert.equal(defaultId,'');assert.equal(lists.length,2);assert.notEqual(lists[0].id,lists[1].id);
  await assert.rejects(reader.addReminder({title:'No list'}),/Choose/);assert.equal(writes.length,0);
  const task=await reader.addReminder({list:lists[1].id,title:'Send review',notes:'Meeting context',due:start});
  assert.equal(writes[0].id,'work');assert.equal(writes[0].args.todo_task_list_id,'same-list-id');assert.deepEqual(writes[0].args.dueDateTime,{dateTime:'2026-10-06T10:00:00.000',timeZone:'UTC'});
  assert.equal(await reader.completeReminder(task,true),true);assert.equal(writes[1].id,'work');assert.equal(writes[1].args.task_id,'task-1');assert.equal(writes[1].args.status,'completed');
  assert.equal(await reader.completeReminder(task,false),false);
  accounts.splice(1,1);await assert.rejects(reader.completeReminder(task,true),/disconnected/);assert.equal(writes.length,3);
});
test('uncertain task creation is surfaced without replay',async()=>{
  let writes=0;const account={provider:'outlook',accountId:'work',email:'work@example.com'};
  const reader=new WindowsCalendarReader({getAccounts:()=>[account],cli:{binary:async()=> 'cli',execute:async()=>{writes++;throw new Error('connection lost after write');}}});
  const list='mstodo:'+Buffer.from(JSON.stringify({accountId:'work',listId:'tasks'})).toString('base64url');
  await assert.rejects(reader.addReminder({list,title:'Review'}),/connection lost/);assert.equal(writes,1);
});
test('Microsoft To Do pagination detects repeated tokens',async()=>{
  let calls=0;
  const reader=new WindowsCalendarReader({getAccounts:()=>[{provider:'outlook',accountId:'work'}],cli:{binary:async()=> 'cli',connections:async()=>[{id:'work',status:'ACTIVE'}],execute:async()=>{calls++;return {successful:true,data:{value:[],next_page_token:'same'}};}}});
  await assert.rejects(reader.reminderLists(),/pagination/);assert.equal(calls,2);
});
