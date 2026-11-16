// Astra regressions: MCP defaults to 2020-12; pagination/concurrent catalogs cannot change call validation.
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createPluginRuntime } from '../plugin-runtime.mjs';
const modern='https://json-schema.org/draft/2020-12/schema';
const tuple={type:'object',properties:{pair:{type:'array',prefixItems:[{type:'string'}],items:false},card:{type:'string'},billing:{type:'string'}},required:['pair'],dependentRequired:{card:['billing']},additionalProperties:false};
const answer={type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false};
const tool=(name,inputSchema={type:'object'},outputSchema,execution)=>({name,inputSchema,...(outputSchema?{outputSchema}:{}),...(execution?{execution}:{})});
const counts=new Map();let revision=1,holdStarted,releaseHold;
const held=new Promise(r=>{holdStarted=r;});const hold=new Promise(r=>{releaseHold=r;});
function page(which,rev){
 if(!which)return [
  tool('implicit',tuple),tool('first-good-output',{type:'object'},tuple),tool('first-bad-output',{type:'object'},answer),tool('first-required',{type:'object'},null,{taskSupport:'required'}),
  tool('concurrent',{type:'object'},{type:'object',properties:{answer:{type:rev===1?'string':'number'}},required:['answer']}),
 ];
 return [
  tool('explicit',{...tuple,$schema:modern}),tool('draft07',{$schema:'http://json-schema.org/draft-07/schema#',type:'object',properties:{pair:{type:'array',items:[{type:'string'}],additionalItems:false}},required:['pair']}),
  tool('unsupported',{$schema:'https://example.test/2020-12/schema',type:'object'}),tool('remote-ref',{type:'object',properties:{reference:{$ref:'https://example.invalid/not-fetched'}}}),
  tool('last-good-output',{type:'object'},{...tuple,$schema:modern}),tool('last-bad-output',{type:'object'},answer),tool('last-required',{type:'object'},null,{taskSupport:'required'}),
  tool('missing-output',{type:'object'},answer),tool('invalid-tuple-output',{type:'object'},tuple),tool('invalid-dependent-output',{type:'object'},tuple),
  tool('unsupported-output',{type:'object'},{$schema:'https://example.test/schema',type:'object'}),tool('error-output',{type:'object'},answer),
 ];
}
const server=http.createServer(async(req,res)=>{
 if(req.method!=='POST'){res.writeHead(405).end();return;}
 const fixture=new Server({name:'schema-fixture',version:'1'},{capabilities:{tools:{listChanged:true}}});
 fixture.setRequestHandler(ListToolsRequestSchema,async({params})=>{const rev=params?.cursor?Number(params.cursor):revision;return {tools:page(!!params?.cursor,rev),...(!params?.cursor?{nextCursor:String(rev)}:{})};});
 fixture.setRequestHandler(CallToolRequestSchema,async({params})=>{
  const name=params.name;counts.set(name,(counts.get(name)??0)+1);
  if(name==='concurrent'){const captured=revision;if(params.arguments?.delay){holdStarted();await hold;}return {content:[],structuredContent:{answer:captured===1?'old':2}};}
  if(name.includes('bad-output'))return {content:[],structuredContent:{wrong:1}};
  if(name==='invalid-tuple-output')return {content:[],structuredContent:{pair:[123]}};
  if(name==='invalid-dependent-output')return {content:[],structuredContent:{pair:['valid'],card:'needs billing'}};
  if(name==='missing-output')return {content:[{type:'text',text:'no structured content'}]};
  if(name==='error-output')return {isError:true,content:[{type:'text',text:'precise server error'}]};
  return {content:[],structuredContent:name.includes('good-output')?{pair:['valid'],card:'present',billing:'present'}:{received:params.arguments}};
 });
 const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
 try{let body='';for await(const chunk of req)body+=chunk;await fixture.connect(transport);res.on('close',()=>{void transport.close();void fixture.close();});await transport.handleRequest(req,res,JSON.parse(body));}
 catch(e){if(!res.headersSent)res.writeHead(500).end(String(e.message));}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const runtime=createPluginRuntime({timeout:3000});const descriptor={type:'streamable-http',url:`http://127.0.0.1:${server.address().port}/mcp`};
const call=(name,args={})=>runtime.invoke('fixture','schema',descriptor,{method:'call_tool',name,argumentsJson:JSON.stringify(args)});
try{
 for(const name of ['implicit','explicit']){
  assert.match(JSON.stringify(await call(name,{pair:['valid']})),/valid/);
  const before=counts.get(name);
  for(const args of [{pair:[123]},{pair:['valid','extra']},{pair:['valid'],card:'missing billing'}])await assert.rejects(call(name,args),/input does not match/);
  assert.equal(counts.get(name),before,'invalid tuples/dependent constraints never reach the server');
 }
 assert.match(JSON.stringify(await call('draft07',{pair:['valid']})),/valid/);await assert.rejects(call('draft07',{pair:[123]}),/input does not match/);
 await assert.rejects(call('unsupported'),/Unsupported MCP input schema dialect/);assert.equal(counts.get('unsupported'),undefined);
 await assert.rejects(call('remote-ref'),/remote references are not fetched/);assert.equal(counts.get('remote-ref'),undefined);
 for(const name of ['first-good-output','last-good-output'])assert.match(JSON.stringify(await call(name)),/valid/);
 for(const name of ['first-bad-output','last-bad-output','invalid-tuple-output','invalid-dependent-output']){await assert.rejects(call(name),/output does not match/);assert.equal(counts.get(name),1,'invalid output is reported without replaying the effect');}
 await assert.rejects(call('missing-output'),/no structured content/);
 await assert.rejects(call('unsupported-output'),/Unsupported MCP output schema dialect/);assert.equal(counts.get('unsupported-output'),undefined);
 await assert.rejects(call('error-output'),/precise server error/,'tool errors retain diagnostics without requiring a successful output shape');
 for(const name of ['first-required','last-required']){await assert.rejects(call(name),/requires task-based execution/);assert.equal(counts.get(name),undefined,'required task execution cannot be lost on an earlier catalog page');}
 const pending=call('concurrent',{delay:true});await held;revision=2;
 await runtime.invoke('fixture','schema',descriptor,{method:'discover'});
 assert.match(JSON.stringify(await call('concurrent')),/:2/);
 releaseHold();assert.match(JSON.stringify(await pending),/old/,'in-flight call retains its captured output schema despite a concurrent catalog refresh');
 const results=await Promise.allSettled([call('first-bad-output'),call('last-bad-output'),call('first-good-output'),call('last-good-output')]);assert.deepEqual(results.map(r=>r.status),['rejected','rejected','fulfilled','fulfilled']);
 console.log('Actual MCP default/explicit dialects, input/output schemas, pagination, required-task guards and concurrent refresh: passed');
}finally{releaseHold();await runtime.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
