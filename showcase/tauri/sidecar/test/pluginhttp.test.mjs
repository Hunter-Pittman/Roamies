import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createPluginRuntime } from '../plugin-runtime.mjs';
import { approvedMcpFetch } from '../plugin-transport.mjs';
import { createPlugins } from '../plugins.mjs';
import { PLUGIN_SCHEMA, MCP_SCHEMA } from '../plugin-format.mjs';
import { createSecrets } from '../secrets.mjs';
import { fixtureSource } from './pluginfixture.mjs';
const temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'roamies-plugin-http-')));
process.env.HOME=process.env.USERPROFILE=temp; // Isolated file policy, including macOS /var/folders fixtures.
await fs.writeFile(path.join(temp,'fixture.mjs'),fixtureSource);
const {fixtureServer}=await import(pathToFileURL(path.join(temp,'fixture.mjs')).href);
const requests=[];
const server=http.createServer(async(req,res)=>{
 requests.push({method:req.method,path:req.url,authorization:req.headers.authorization,literal:req.headers['x-literal']});
 if(req.url==='/redirect'){res.writeHead(307,{location:'http://localhost:1/leak'}).end();return;}
 if(req.url==='/unauthorized'){res.writeHead(401).end();return;}
 if(req.method!=='POST'){res.writeHead(405).end();return;}
 const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
 const fixture=fixtureServer();
 try {let body='';for await(const chunk of req)body+=chunk;await fixture.connect(transport);res.on('close',()=>{void transport.close();void fixture.close();});await transport.handleRequest(req,res,JSON.parse(body));}
 catch(e){if(!res.headersSent)res.writeHead(500).end(String(e.message));}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const endpoint=`http://127.0.0.1:${server.address().port}/mcp`;
let mgr;const runtime=createPluginRuntime({timeout:2000,token:async()=> 'SECRET-TOKEN',redact:s=>s.replaceAll('SECRET-TOKEN','[redacted]')});
try{
 const descriptor={type:'streamable-http',url:endpoint,headers:{'X-Literal':'${PLUGIN_ROOT}',Authorization:'package-token'},origin:new URL(endpoint).origin};
 const invoke=(method,name,argumentsJson)=>runtime.invoke('fixture','remote',descriptor,{method,name,argumentsJson});
 assert.match(JSON.stringify(await invoke('discover')),/echo/);
 assert.match(JSON.stringify(await invoke('call_tool','echo','{"nested":{"value":null}}')),/null/);
 await assert.rejects(invoke('call_tool','fail','{}'),e=>e.message.includes('[redacted]')&&!e.message.includes('SECRET-TOKEN'));
 assert.ok(requests.filter(r=>r.method==='POST').every(r=>r.authorization==='Bearer SECRET-TOKEN'&&r.literal==='${PLUGIN_ROOT}'),'client auth wins; package header placeholders stay literal');
 const guard=approvedMcpFetch(endpoint,{'X-Literal':'sensitive'});
 await assert.rejects(guard(endpoint.replace('/mcp','/redirect')),/redirects/);
 await assert.rejects(guard('http://localhost:1/leak'),/approved origin/);
 const methods=[];const fake=approvedMcpFetch(endpoint,{},null,async(_u,options)=>{methods.push(options.method);return new Response('{}',{headers:{'content-type':'application/json'}});});
 for(const method of ['GET','POST','DELETE'])await fake(endpoint,{method});assert.deepEqual(methods,['GET','POST','DELETE']);
 const oversized=approvedMcpFetch(endpoint,{},null,async()=>new Response('x',{headers:{'content-length':String(9<<20)}}));await assert.rejects(oversized(endpoint),/size limit/);
 const giant=approvedMcpFetch(endpoint,{},null,async()=>new Response('x'.repeat((8<<20)+1)));await assert.rejects((await giant(endpoint)).text(),/size limit/);
 await assert.rejects(runtime.invoke('bad','auth',{...descriptor,url:endpoint.replace('/mcp','/unauthorized')},{method:'discover'}),/401|Unauthorized|unauthorized/i);
 assert.match(JSON.stringify(await invoke('discover')),/fixture/,'independent server survives an authentication failure');
 const source=path.join(temp,'package'),owned=path.join(temp,'owned');await fs.mkdir(source);await fs.mkdir(owned);
 await fs.writeFile(path.join(source,'plugin.json'),JSON.stringify({$schema:PLUGIN_SCHEMA,name:'remote'}));await fs.writeFile(path.join(source,'mcp.json'),JSON.stringify({$schema:MCP_SCHEMA,mcpServers:{remote:{type:'streamable-http',url:endpoint}}}));
 const secrets=createSecrets({platform:'win32',dataDir:path.join(temp,'secrets'),exec:async(_cmd,args,input)=>({code:0,stdout:args.at(-1).includes('::Protect(')?Buffer.from(input).toString('base64'):Buffer.from(input,'base64').toString()})});
 mgr=createPlugins({root:owned,allowActions:()=>true,confirm:async()=>true,secrets,askSecret:async()=> 'SECRET-TOKEN'});await mgr.ready;const{id}=await mgr.install(source);await mgr.enable(id);
 const tokenTool=mgr.tools.find(t=>t.name==='plugin_token');await tokenTool.execute({id,server:'remote'});
 const call={id,server:'remote',method:'call_tool',name:'fail',argumentsJson:'{}'};await assert.rejects(mgr.invoke(call),e=>e.message.includes('[redacted]')&&!e.message.includes('SECRET-TOKEN'));
 assert.ok(!JSON.stringify(await mgr.list()).includes('SECRET-TOKEN'));assert.ok(!(await fs.readFile(path.join(owned,'state.json'),'utf8')).includes('SECRET-TOKEN'));
 console.log('Actual Streamable HTTP, origin/header protections, credentials and redacted errors: passed');
}finally{await mgr?.close();await runtime.close();server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
