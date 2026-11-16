import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPlugins } from '../plugins.mjs';
import { createAgents } from '../agents.mjs';
import { createSupervisors } from './supervisorfixture.mjs';
import { checkRead, checkWrite, checkOpen } from '../safety.mjs';
import { PLUGIN_SCHEMA, MCP_SCHEMA } from '../plugin-format.mjs';
const temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'roamies-plugin-worker-')));
process.env.HOME=process.env.USERPROFILE=temp; // Isolated file policy, including macOS /var/folders fixtures.
const source=path.join(temp,'source'),root=path.join(temp,'plugins');await fs.mkdir(source);await fs.mkdir(root);
await fs.writeFile(path.join(source,'plugin.json'),JSON.stringify({$schema:PLUGIN_SCHEMA,name:'same-name'}));await fs.mkdir(path.join(source,'skills','brief'),{recursive:true});
await fs.writeFile(path.join(source,'skills','brief','SKILL.md'),'---\nname: brief\ndescription: Experiment brief.\n---\nMake a concise brief.');
await fs.writeFile(path.join(source,'mcp.json'),JSON.stringify({$schema:MCP_SCHEMA,mcpServers:{fixture:{type:'streamable-http',url:'http://127.0.0.1:1/mcp'}}}));
let holdStarted;const holding=new Promise(r=>{holdStarted=r;});
const calls=[];const plugins=createPlugins({root,allowActions:()=>true,confirm:async()=>true,runtime:{status:()=>[],revoke:async()=>{},close:async()=>{},invoke:async(_id,_server,_d,args,signal)=>{
 calls.push(args);if(args.name==='hold'){holdStarted();return new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(new Error('capability revoked')),{once:true}));}
 return {content:[{type:'text',text:args.argumentsJson??'discovered'}]};
}}});
let agents,supervisors;
try{
 await plugins.ready;const{id}=await plugins.install(source),other=await plugins.install(source);assert.notEqual(id,other.id,'same manifest names have independent instances');await plugins.enable(id);await plugins.enable(other.id);
 const fake=path.join(temp,'fake.mjs'),log=path.join(temp,'worker.json');
 await fs.writeFile(fake,`import fs from 'node:fs';export default class Fake {constructor(o){this.o=o;}prompt(){const self=this;async function* run(){const tools=self.o.tools;const results={tools:tools.map(t=>t.name),system:self.o.system};const call=async(name,args)=>tools.find(t=>t.name===name).execute(args,{signal:self.o.signal});results.skill=await call('plugin_skill',{id:process.env.FIXTURE_PLUGIN_ID,skill:'brief'});results.echo=await call('plugin_mcp',{id:process.env.FIXTURE_PLUGIN_ID,server:'fixture',method:'call_tool',name:'echo',argumentsJson:'{"nested":{"value":null}}'});try{await call('plugin_mcp',{id:process.env.FIXTURE_OTHER_ID,server:'fixture',method:'discover'});}catch(e){results.denied=e.message;}try{await call('plugin_mcp',{id:process.env.FIXTURE_PLUGIN_ID,server:'fixture',method:'call_tool',name:'hold'});}catch(e){results.revoked=e.message;}fs.writeFileSync(process.env.FIXTURE_WORKER_LOG,JSON.stringify(results));await call('finish',{outcome:'Checked plugins.',report:'Completed capability checks.'});yield {type:'turn_end',usage:{}};}const g=run();return {[Symbol.asyncIterator]:()=>g,then:(a,b)=>Promise.resolve({}).then(a,b)};}}`);
 process.env.ROAMIES_FAKE_AGENT=fake;process.env.FIXTURE_PLUGIN_ID=id;process.env.FIXTURE_OTHER_ID=other.id;process.env.FIXTURE_WORKER_LOG=log;
 let finish;const ended=new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('Worker IPC timed out.')),20000);finish=e=>{clearTimeout(t);resolve(e);};});
 agents=createAgents({fork,root:path.join(temp,'agents'),home:os.homedir(),userName:'Tester',runner:fileURLToPath(new URL('../agentrun.mjs',import.meta.url)),safety:{checkRead,checkWrite,checkOpen},config:{plugins,model:async()=>({provider:'palsu',model:'fixture'}),allowActions:()=>true,creds:async()=>({}),open:async()=>{},reveal:async()=>{}},ui:({e})=>{if(['done','fail','gone'].includes(e.type))finish(e);}});
 await agents.start({type:'researcher',title:'Plugin IPC',brief:'Check explicitly selected plugins.',plugins:[id],returns:'answer'});
 await Promise.race([holding,ended.then(e=>{throw new Error(`Worker ended before IPC hold: ${e.agent.reason}`);})]);await plugins.manage({action:'disable',id});const event=await ended;assert.equal(event.type,'done',event.agent.reason);
 const result=JSON.parse(await fs.readFile(log,'utf8'));assert.ok(result.tools.includes('plugin_mcp'));assert.ok(!result.tools.includes('manage_plugin')&&!result.tools.includes('plugin_token'));
 assert.match(result.skill,/concise brief/);assert.match(result.echo.content[0].text,/null/);assert.match(result.denied,/unavailable|revoked/);assert.match(result.revoked,/revoked/);assert.equal(calls.length,2,'unselected instance never reaches runtime');
 let launches=0;supervisors=createSupervisors({root:path.join(temp,'supervisors'),intervalMs:0,allowDispatch:()=>true,pluginCapabilities:(...a)=>plugins.supervisorCapabilities(...a),orca:{launchSupervisor:async()=>{launches++;}}});await supervisors.ready;
 const create=supervisors.tools.find(t=>t.name==='create_supervisor');await assert.rejects(create.execute({workspace:'identity:wt2:local:fixture',agent:'codex',title:'Needs tools',objective:'Use MCP',instructions:'Use the MCP server.',plugins:[other.id],needsPluginMcp:true}),/No supervisor was launched/);assert.equal(launches,0);assert.equal(supervisors.snapshot().supervisors.length,0);
 console.log('Real forked worker selected-capability IPC, revocation and supervisor preflight: passed');
}finally{agents?.stopAll();await supervisors?.close();await plugins.close();for(const key of ['ROAMIES_FAKE_AGENT','FIXTURE_PLUGIN_ID','FIXTURE_OTHER_ID','FIXTURE_WORKER_LOG'])delete process.env[key];await fs.rm(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
