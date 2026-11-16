import { pathToFileURL } from 'node:url';
const moduleUrl = (relative) => new URL(`../node_modules/@modelcontextprotocol/sdk/dist/esm/${relative}`, import.meta.url).href;
export const fixtureSource = `
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Server } from ${JSON.stringify(moduleUrl('server/index.js'))};
import { StdioServerTransport } from ${JSON.stringify(moduleUrl('server/stdio.js'))};
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from ${JSON.stringify(moduleUrl('types.js'))};
export function fixtureServer() {
 const server = new Server({ name:'fixture', version:'1' }, { capabilities:{ tools:{listChanged:true}, resources:{}, prompts:{} }, instructions:'Untrusted fixture instruction' });
 const names=['echo','fail','image','slow','child','mutate']; let mutated=false;
 server.setRequestHandler(ListToolsRequestSchema, async ({params})=> ({tools: params?.cursor ? names.slice(1).map(name=>({name,inputSchema:{type:'object'}})) : [{name:'echo',inputSchema:{type:'object',properties:{nested:{type:'object',properties:{value:{type:['string','null']}}}},additionalProperties:false}}], ...(params?.cursor?{}:{nextCursor:'second'})}));
 server.setRequestHandler(CallToolRequestSchema, async ({params}, extra)=> {
   if(params.name==='fail') return {isError:true,content:[{type:'text',text:'fixture failed SECRET-TOKEN'}]};
   if(params.name==='image') return {content:[{type:'image',mimeType:'image/png',data:'aGVsbG8='}]};
   if(params.name==='slow') { await new Promise(resolve=> { const t=setTimeout(resolve,5000); extra.signal.addEventListener('abort',()=>{clearTimeout(t);resolve();},{once:true}); }); return {content:[{type:'text',text:'late'}]}; }
   if(params.name==='child') { const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}); fs.writeFileSync(path.join(process.env.PLUGIN_DATA,'child.pid'),String(child.pid)); return {content:[{type:'text',text:String(child.pid)}]}; }
   if(params.name==='mutate') { mutated=true; await server.sendToolListChanged(); }
   return {content:[],structuredContent:{received:params.arguments,mutated}};
 });
 server.setRequestHandler(ListResourcesRequestSchema, async ()=>({resources:[{name:'fixture',uri:'fixture://notes'}]}));
 server.setRequestHandler(ListResourceTemplatesRequestSchema, async ()=>({resourceTemplates:[]}));
 server.setRequestHandler(ReadResourceRequestSchema, async ({params})=>({contents:[{uri:params.uri,text:'local fixture resource'}]}));
 server.setRequestHandler(ListPromptsRequestSchema, async ()=>({prompts:[{name:'brief',arguments:[{name:'topic'}]}]}));
 server.setRequestHandler(GetPromptRequestSchema, async ({params})=>({messages:[{role:'user',content:{type:'text',text:'Brief '+params.arguments.topic}}]}));
 return server;
}
if (process.argv.includes('--stdio')) {
 fs.writeFileSync(path.join(process.env.PLUGIN_DATA,'started.json'),JSON.stringify({pid:process.pid,cwd:process.cwd(),args:process.argv.slice(2),ambient:process.env.ORCA_SECRET_TEST??null,api:process.env.OPENAI_API_KEY??null}));
 await fixtureServer().connect(new StdioServerTransport());
}
`;
