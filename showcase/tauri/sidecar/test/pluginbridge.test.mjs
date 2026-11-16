import assert from 'node:assert/strict';
import { Agent } from '@kenkaiiii/gg-agent';
import { registerPalsuProvider, palsuToolCall, palsuText, resolveToolSchema } from '@kenkaiiii/gg-ai';
import { z } from 'zod';
import { createToolBridge } from '../claudecode.mjs';
import { normalizeMcpResult } from '../plugin-runtime.mjs';
import { createPlugins, mcpRequestSchema } from '../plugins.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_SCHEMA } from '../plugin-format.mjs';
const seen=[];
const tool={name:'plugin_mcp',description:'MCP fixture adapter',parameters:mcpRequestSchema,execute:async args=>{
 const input=JSON.parse(args.argumentsJson);seen.push(input);if(args.name==='fail')return normalizeMcpResult({isError:true,content:[{type:'text',text:'precise failure'}]});
 return normalizeMcpResult({content:[],structuredContent:input});
}};
const args={id:'fixture',server:'server',method:'call_tool',name:'echo',argumentsJson:'{"nested":{"value":null}}'};
assert.equal(resolveToolSchema(tool).properties.argumentsJson.type,'string');
const provider=registerPalsuProvider();
try{
 for(const name of ['echo','fail']){
  provider.setResponses([palsuToolCall('plugin_mcp',{...args,name}),palsuText('done')]);
  const agent=new Agent({provider:'palsu',model:'fixture',tools:[tool],maxTurns:2});const events=[];
  for await(const event of agent.prompt('run the fixture'))events.push(event);
  const ended=events.find(e=>e.type==='tool_call_end');assert.ok(ended);assert.equal(ended.isError,name==='fail');assert.match(JSON.stringify(ended),name==='fail'?/precise failure/:/null/);
 }
 const events=[],bridge=createToolBridge({tools:[tool],onEvent:e=>events.push(e)});
 const replies=new Map(),transport={async send(message){replies.get(message.id)?.(message);}};await bridge.config.instance.connect(transport);
 let id=0;const rpc=(params)=>new Promise(resolve=>{const key=++id;replies.set(key,resolve);transport.onmessage({jsonrpc:'2.0',id:key,method:'tools/call',params});});
 const success=await rpc({name:'plugin_mcp',arguments:args});assert.match(success.result.content[0].text,/null/);
 const error=await rpc({name:'plugin_mcp',arguments:{...args,name:'fail'}});assert.equal(error.result.isError,true);assert.match(error.result.content[0].text,/precise failure/);
 assert.ok(events.some(e=>e.type==='tool_call_end'&&e.isError));assert.ok(seen.every(v=>v.nested.value===null),'both provider paths preserve nested nulls');
 const image=normalizeMcpResult({content:[{type:'image',mimeType:'image/png',data:'eA=='}]});assert.equal(image.content[0].mediaType,'image/png');
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'roamies-plugin-tools-'));let manager;
 process.env.HOME=process.env.USERPROFILE=temp; // Isolated file policy, including macOS /var/folders fixtures.
 try {
  const source=path.join(temp,'source');await fs.mkdir(path.join(source,'skills','brief'),{recursive:true});await fs.writeFile(path.join(source,'plugin.json'),JSON.stringify({$schema:PLUGIN_SCHEMA,name:'actual-tools'}));await fs.writeFile(path.join(source,'skills','brief','SKILL.md'),'---\nname: brief\ndescription: Actual tool fixture.\n---\nMake a brief.');
  let approvals=0,installedId;manager=createPlugins({root:path.join(temp,'owned'),allowActions:()=>true,confirm:async()=>{approvals++;return true;}});await manager.ready;
  provider.setResponses([
   palsuToolCall('manage_plugin',{action:'install',source}),
   messages=>{const last=messages.filter(m=>m.role==='tool').at(-1).content[0];installedId=JSON.parse(last.content).id;return palsuToolCall('manage_plugin',{action:'enable',id:installedId});},
   ()=>palsuToolCall('plugin_skill',{id:installedId,skill:'brief'}),palsuToolCall('plugins',{}),palsuText('ready'),
  ]);
  const actual=new Agent({provider:'palsu',model:'fixture',tools:manager.tools,maxTurns:5});const results=[];for await(const event of actual.prompt('Install and use my local plugin.'))if(event.type==='tool_call_end')results.push(event);
  assert.equal(results.length,4);assert.ok(results.every(r=>!r.isError),JSON.stringify(results));assert.equal(approvals,1);assert.match(JSON.stringify(results),/Make a brief/);
 } finally {await manager?.close();await fs.rm(temp,{recursive:true,force:true});}
 console.log('Actual gg-agent executor and Claude MCP bridge preserve content, errors and nested nulls: passed');
}finally{provider.unregister();}
