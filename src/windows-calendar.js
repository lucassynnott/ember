const PROVIDERS = {
  googlecalendar: { origin:'https://www.googleapis.com', label:'Google Calendar' },
  outlook: { origin:'https://graph.microsoft.com', label:'Outlook' },
};
function callLink(...values) {
  for(const value of values)for(const match of String(value||'').matchAll(/https?:\/\/[^\s<>"']+/g)){
    try {const url=new URL(match[0].replaceAll('&amp;','&'));if(!url.username&&!url.password&&/(^|\.)(zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com|meet\.jit\.si)$/.test(url.hostname))return url.href;}catch{}
  }
  return null;
}
function eventTime(value, provider){
  if(!value)return NaN;
  if(value.date)return new Date(value.date+'T00:00:00').getTime();
  let text=value.dateTime;
  // Graph calendarView defaults to UTC unless a Prefer timezone header is supplied.
  if(provider==='outlook'&&text&&!/[zZ]|[+-]\d\d:\d\d$/.test(text)){
    if(value.timeZone&&value.timeZone!=='UTC'&&value.timeZone!=='Etc/UTC')throw new Error('Outlook returned a non-UTC calendar time.');
    text+='Z';
  }
  return new Date(text).getTime();
}
function normalizeEvent(event,provider,calendar,email=''){
  if(event.status==='cancelled'||event.isCancelled)return null;
  const start=eventTime(event.start,provider),end=eventTime(event.end,provider);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return null;
  return {id:`${provider}:${calendar.id}:${event.id}`,title:String(event.summary||event.subject||'').slice(0,500),start,end,calendar:calendar.summary||calendar.name||'',allDay:Boolean(event.start?.date||event.isAllDay),recurring:Boolean(event.recurringEventId||event.recurrence||['occurrence','exception','seriesMaster'].includes(event.type)),link:callLink(event.hangoutLink,event.conferenceData?.entryPoints?.find(point=>point.entryPointType==='video')?.uri,event.onlineMeeting?.joinUrl,event.location?.displayName,event.location,event.description,event.body?.content),attendees:(event.attendees||[]).map(person=>({name:person.displayName||person.emailAddress?.name||'',email:person.email||person.emailAddress?.address||'',me:Boolean(person.self||(email&&(person.email||person.emailAddress?.address||'').toLowerCase()===email.toLowerCase())),declined:person.responseStatus==='declined'||person.status?.response==='declined'}))};
}
class WindowsCalendarReader {
  constructor({cli,getAccounts=()=>[],saveAccounts=async()=>{},onProgress=()=>{}}){Object.assign(this,{cli,getAccounts,saveAccounts,onProgress});this.connecting=null;}
  async status(){
    const accounts=this.getAccounts();if(!accounts.length)return 'not-determined';
    const binary=await this.cli.binary();if(!binary)return 'not-determined';
    for(const account of accounts){
      if(!PROVIDERS[account.provider])continue;
      const connections=await this.cli.connections(binary,account.provider);
      if(connections?.some(item=>item.status==='ACTIVE'&&(item.id===account.accountId||item.word_id===account.accountId)))return 'granted';
    }
    return 'denied';
  }
  request(provider){
    if(!PROVIDERS[provider])return Promise.reject(new Error('Choose Google Calendar or Outlook.'));
    if(this.connecting)return Promise.reject(new Error('Finish the current calendar connection first.'));
    const pending=this.#connect(provider);this.connecting=pending;
    const clear=()=>{if(this.connecting===pending)this.connecting=null;};pending.then(clear,clear);return pending;
  }
  async #connect(provider){
    const job={controller:new AbortController()};
    const binary=await this.cli.prepare(job,this.onProgress);
    const connection=await this.cli.link(binary,job,this.onProgress,provider,PROVIDERS[provider].label);
    const accountId=connection.word_id||connection.id;
    if(!accountId)throw new Error('Calendar connection did not identify its account.');
    const identity=provider==='outlook'?await this.#get(binary,provider,accountId,'/v1.0/me?$select=mail,userPrincipalName'):await this.#get(binary,provider,accountId,'/calendar/v3/calendars/primary');
    const email=provider==='outlook'?(identity.mail||identity.userPrincipalName):identity.id;
    if(!email)throw new Error('Calendar account identity could not be verified.');
    const accounts=this.getAccounts().filter(item=>!(item.provider===provider&&item.accountId===accountId));
    if(accounts.length>=20)throw new Error('Ember supports up to 20 calendar accounts.');
    await this.saveAccounts([...accounts,{provider,accountId,email:String(email).slice(0,320)}]);
    return 'granted';
  }
  async #get(binary,provider,accountId,route){
    const url=new URL(route,PROVIDERS[provider].origin);
    if(url.origin!==PROVIDERS[provider].origin||url.username||url.password)throw new Error('Calendar pagination returned an unexpected address.');
    const result=await this.cli.proxy(binary,url.href,{toolkit:provider},accountId,30000);
    if(result?.error||result?.successful===false)throw new Error('The calendar provider could not return events.');
    return result;
  }
  async #pages(binary,account,route,key){
    const items=[],seen=new Set();let next=route;
    while(next){
      if(seen.has(next)||seen.size>=100)throw new Error('Calendar pagination exceeded its limit.');seen.add(next);
      const page=await this.#get(binary,account.provider,account.accountId,next);
      if(!Array.isArray(page[key]))throw new Error('The calendar provider returned an invalid list.');
      items.push(...page[key]);if(items.length>10000)throw new Error('The calendar result exceeds its limit.');
      if(account.provider==='outlook')next=page['@odata.nextLink']||null;
      else if(page.nextPageToken){const url=new URL(route,PROVIDERS.googlecalendar.origin);url.searchParams.set('pageToken',page.nextPageToken);next=url.href;}
      else next=null;
    }
    return items;
  }
  async events(from,to){
    if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from||to-from>366*86400000)throw new Error('Invalid calendar time range.');
    const accounts=this.getAccounts();if(!accounts.length)return [];
    const binary=await this.cli.binary();if(!binary)throw new Error('Connect your calendar in Settings first.');
    const events=[];
    for(const account of accounts){
      if(!PROVIDERS[account.provider])throw new Error('Unknown calendar provider.');
      const google=account.provider==='googlecalendar';
      const calendars=await this.#pages(binary,account,google?'/calendar/v3/users/me/calendarList?maxResults=250&showHidden=false':'/v1.0/me/calendars?$top=100',google?'items':'value');
      for(const calendar of calendars){
        const params=new URLSearchParams(google?{timeMin:new Date(from).toISOString(),timeMax:new Date(to).toISOString(),singleEvents:'true',orderBy:'startTime',maxResults:'2500'}:{startDateTime:new Date(from).toISOString(),endDateTime:new Date(to).toISOString(),$top:'1000'});
        const route=google?`/calendar/v3/calendars/${encodeURIComponent(calendar.id)}/events?${params}`:`/v1.0/me/calendars/${encodeURIComponent(calendar.id)}/calendarView?${params}`;
        for(const item of await this.#pages(binary,account,route,google?'items':'value')){
          const event=normalizeEvent(item,account.provider,calendar,account.email);
          if(event&&event.end>from&&event.start<to)events.push(event);
        }
      }
    }
    return events.sort((a,b)=>a.start-b.start);
  }
  async remindersStatus(){
    const accounts=this.getAccounts().filter(account=>account.provider==='outlook');
    if(!accounts.length)return 'not-determined';
    const binary=await this.cli.binary();if(!binary)return 'not-determined';
    const connections=await this.cli.connections(binary,'outlook');
    return accounts.some(account=>connections?.some(item=>item.status==='ACTIVE'&&(item.id===account.accountId||item.word_id===account.accountId)))?'granted':'denied';
  }
  async requestReminders(){throw new Error('Connect Microsoft To Do in Settings → Notes & connections, then choose a list.');}
  async #taskTool(accountId,slug,args){
    if(!this.getAccounts().some(account=>account.provider==='outlook'&&account.accountId===accountId))throw new Error('The Microsoft To Do account is disconnected. Choose a connected account and list again.');
    const binary=await this.cli.binary();if(!binary)throw new Error('Connect Microsoft To Do first.');
    // Mutations execute once. An uncertain result is surfaced, never replayed.
    const result=await this.cli.execute(binary,slug,{user_id:'me',...args},accountId,30000);
    if(!result?.successful)throw new Error('Microsoft To Do could not complete the request. Check the account permissions and retry only after checking the task.');
    return result.data?.response_data || result.data;
  }
  #taskReference(id,withTask=false){
    let value;
    try {
      if(typeof id!=='string'||!id.startsWith('mstodo:')||id.length>6000)throw new Error();
      value=JSON.parse(Buffer.from(id.slice(7),'base64url').toString('utf8'));
      for(const key of ['accountId','listId',...(withTask?['taskId']:[])])if(typeof value[key]!=='string'||!value[key]||value[key].length>1500)throw new Error();
    }catch{throw new Error('Choose a Microsoft To Do list in Settings first.');}
    if(!this.getAccounts().some(account=>account.provider==='outlook'&&account.accountId===value.accountId))throw new Error('The Microsoft To Do account is disconnected.');
    return value;
  }
  async reminderLists(){
    const status=await this.remindersStatus();if(status!=='granted')return {status,lists:[],defaultId:''};
    const lists=[];
    for(const account of this.getAccounts().filter(item=>item.provider==='outlook')){
      let token=null;const seen=new Set();
      do {
        const data=await this.#taskTool(account.accountId,'OUTLOOK_LIST_TO_DO_LISTS',token?{page_token:token}:{});
        const page=data?.value || data?.task_lists;
        if(!Array.isArray(page))throw new Error('Microsoft To Do returned an invalid list.');
        for(const list of page){
          if(typeof list.id!=='string'||!list.id)throw new Error('Microsoft To Do returned an invalid list identity.');
          const id='mstodo:'+Buffer.from(JSON.stringify({accountId:account.accountId,listId:list.id})).toString('base64url');
          lists.push({id,title:`${list.displayName || 'Untitled list'} · ${account.email}`});
        }
        token=data.next_page_token || null;
        if(token){if(typeof token!=='string'||seen.has(token)||seen.size>=100)throw new Error('Microsoft To Do pagination exceeded its limit.');seen.add(token);}
        if(lists.length>10000)throw new Error('Microsoft To Do returned too many lists.');
      }while(token);
    }
    // There is no implicit default across personal and work accounts.
    return {status,lists,defaultId:''};
  }
  async addReminder({list='',title,notes='',due=null}){
    const reference=this.#taskReference(list);
    if(typeof title!=='string'||!title.trim())throw new Error('A task needs a title.');
    const args={todo_task_list_id:reference.listId,title:title.slice(0,255),body:{contentType:'text',content:String(notes).slice(0,4000)}};
    if(due!==null){if(!Number.isFinite(due))throw new Error('Invalid task due date.');args.dueDateTime={dateTime:new Date(due).toISOString().replace(/Z$/,''),timeZone:'UTC'};}
    const data=await this.#taskTool(reference.accountId,'OUTLOOK_CREATE_TASK',args);
    const taskId=data?.id || data?.task?.id;
    if(typeof taskId!=='string'||!taskId)throw new Error('Microsoft To Do did not return the created task identity. Check the selected list before trying again.');
    return 'mstodo:'+Buffer.from(JSON.stringify({...reference,taskId})).toString('base64url');
  }
  async completeReminder(id,done){
    if(typeof done!=='boolean')throw new Error('Invalid task completion state.');
    const reference=this.#taskReference(id,true);
    const data=await this.#taskTool(reference.accountId,'OUTLOOK_UPDATE_TODO_TASK',{todo_task_list_id:reference.listId,task_id:reference.taskId,status:done?'completed':'notStarted'});
    const task=data?.task || data;
    if(task?.id!==reference.taskId||task.status!==(done?'completed':'notStarted'))throw new Error('Microsoft To Do did not confirm the task state. Check the task before trying again.');
    return done;
  }
}
module.exports={WindowsCalendarReader,normalizeEvent,callLink};
