// Run after bundle.sh: node test/pluginpackaging.mjs [bundled-node-path]. No accounts or external services.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPlugins } from '../plugins.mjs';
import { PLUGIN_SCHEMA } from '../plugin-format.mjs';
import { createPluginRuntime } from '../plugin-runtime.mjs';
const temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'roamies-plugin-package-')));
process.env.HOME=process.env.USERPROFILE=temp; // Isolated file policy, including macOS /var/folders fixtures.
const source=path.join(temp,'fixture'),stage=path.join(temp,'app');await fs.mkdir(source);await fs.mkdir(path.join(source,'skills','brief'),{recursive:true});
await fs.writeFile(path.join(source,'plugin.json'),JSON.stringify({$schema:PLUGIN_SCHEMA,name:'package-fixture'}));await fs.writeFile(path.join(source,'skills','brief','SKILL.md'),'---\nname: brief\ndescription: Package fixture.\n---\nMake a brief.');
await fs.cp(fileURLToPath(new URL('../dist',import.meta.url)),stage,{recursive:true});
const node=path.resolve(process.argv[2]??process.execPath);
async function smoke(name,unavailable){
 const home=path.join(temp,name),data=path.join(home,'data');await fs.mkdir(home);
 const plugins=createPlugins({root:path.join(data,'Roamies','Plugins'),allowActions:()=>true,confirm:async()=>true});await plugins.ready;const{id}=await plugins.install(source);await plugins.enable(id);await plugins.close();
 const child=spawn(node,[path.join(stage,'sidekick.mjs')],{cwd:home,windowsHide:true,env:{...process.env,HOME:home,USERPROFILE:home,ROAMIES_DATA_DIR:data,ROAMIES_HANDS:'',ROAMIES_VOICE:''},stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const ended=new Promise((resolve,reject)=>{child.on('close',code=>resolve(code));child.on('error',reject);});
 try{
  let logged='';for(let i=0;i<150;i++){
   const logs=path.join(data,'sidekick','logs');const names=await fs.readdir(logs).catch(()=>[]);logged=(await Promise.all(names.map(n=>fs.readFile(path.join(logs,n),'utf8')))).join('\n');
   if(logged.includes('plugins_ready'))break;await new Promise(r=>setTimeout(r,100));
  }
  assert.match(logged,/plugins_ready/,stderr);assert.match(logged,new RegExp(`"unavailable":${unavailable}`));assert.match(stdout,/onboarding/);
  if (!unavailable) {
   const owned=path.join(data,'Roamies','Plugins'),state=JSON.parse(await fs.readFile(path.join(owned,'state.json'),'utf8'));
   const orca=state.plugins.find(p=>p.bundledKey==='orca');assert.ok(orca?.enabled,'relocated app migrates the bundled Orca plugin automatically');
   const runtime=createPluginRuntime({timeout:5000});
   try {const result=await runtime.invoke('package-smoke','orca',{type:'stdio',executable:node,args:[path.join(owned,orca.snapshot,'server.mjs')],cwd:home,env:{...process.env,HOME:home,USERPROFILE:home}},{method:'discover'});assert.match(JSON.stringify(result),/orca_status/);assert.match(JSON.stringify(result),/create_supervisor/);}
   finally {await runtime.close();}
  }
 }finally{child.stdin.end();const code=await Promise.race([ended,new Promise((_,reject)=>{const t=setTimeout(()=>{child.kill();reject(new Error('Packaged sidecar failed to close.'));},22000);t.unref();})]);assert.equal(code,0,stderr);}
}
try{
 await smoke('positive',0);
 await fs.rename(path.join(stage,'plugin-schemas'),path.join(stage,'missing-schemas'));
 await smoke('missing-assets',1);
 console.log('Packaged sidekick on bundled Node, relocated outside repo/node_modules, and missing-assets negative control: passed');
}finally{await fs.rm(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
