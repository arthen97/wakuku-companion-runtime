// mEnv Node gateway. Only approved exported files belong in ./dist.
// All model credentials remain on the API server. Never proxy arbitrary URLs.
import http from 'node:http';
import https from 'node:https';
import {createReadStream} from 'node:fs';
import {stat, realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {cloud} from './cloud.mjs';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const base = process.env.WAKUKU_BACKEND_URL ? new URL(process.env.WAKUKU_BACKEND_URL) : null;
const secret = process.env.WAKUKU_GATEWAY_SECRET || '';
if (base && (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
    (base.protocol !== 'https:' && !['127.0.0.1','localhost'].includes(base.hostname)))) throw Error('Invalid backend origin');
const client = base?.protocol === 'https:' ? https : http;
const origin = process.env.PUBLIC_ORIGIN || '';
const common = {'x-content-type-options':'nosniff', 'referrer-policy':'same-origin',
  'permissions-policy':'microphone=(self), camera=(), geolocation=(self)'};
function reply(res, status, body) {
  res.writeHead(status, {...common,'content-type':'application/json','cache-control':'no-store'});
  res.end(JSON.stringify(body));
}
function options(req, apiPath) {
  // Remove caller-supplied forwarding and gateway headers; preserve Origin and
  // HttpOnly cookie so the API, not the browser, authenticates every request.
  return {protocol:base.protocol,hostname:base.hostname,port:base.port,
    method:req.method,path:apiPath,timeout:110000,headers:{
      host:base.host,'x-wakuku-gateway':secret,
      ...(req.headers.origin ? {origin:req.headers.origin}:{}),
      ...(req.headers.cookie ? {cookie:req.headers.cookie}:{}),
      ...(req.headers['content-type'] ? {'content-type':req.headers['content-type']}:{}),
      ...(req.headers['content-length'] ? {'content-length':req.headers['content-length']}:{}),
      ...(req.headers.upgrade ? {connection:'Upgrade',upgrade:'websocket',
        'sec-websocket-key':req.headers['sec-websocket-key'],
        'sec-websocket-version':req.headers['sec-websocket-version']}:{}),
    }};
}
function configured(){return !!base && secret.length>=32 && !!origin;}
const mime={'.html':'text/html;charset=utf-8','.js':'text/javascript','.mjs':'text/javascript',
  '.css':'text/css','.json':'application/json','.wasm':'application/wasm','.pck':'application/octet-stream',
  '.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.wav':'audio/wav','.ogg':'audio/ogg','.mp3':'audio/mpeg'};
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://gateway');
    if(url.pathname==='/health/live')return reply(res,200,{live:true,api_configured:base?configured():cloud.health().available,mode:base?'private_api_gateway':'merouter_direct',public_ready:false});
    if(url.pathname.startsWith('/broker/')){
      if(!base)return await cloud.handle(req,res,url);
      if(!configured())return reply(res,503,{error:'backend_not_configured'});
      if(!['GET','POST','HEAD'].includes(req.method))return reply(res,405,{});
      if(req.method==='POST' && req.headers.origin!==origin)return reply(res,403,{error:'origin'});
      if(Number(req.headers['content-length']||0)>3600000)return reply(res,413,{});
      const upstream=client.request(options(req,url.pathname.slice('/broker'.length)+url.search),r=>{
        res.writeHead(r.statusCode,{...common,...Object.fromEntries(Object.entries(r.headers).filter(([k])=>
          ['content-type','content-length','set-cookie','cache-control'].includes(k)))});
        r.pipe(res);r.on('error',()=>res.destroy());
      });
      let bytes=0;
      req.on('data',x=>{bytes+=x.length;if(bytes>3600000){upstream.destroy();req.destroy();}});
      req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());
      upstream.on('timeout',()=>upstream.destroy());
      upstream.on('error',()=>{if(!res.headersSent)reply(res,503,{error:'backend_unavailable'});else res.destroy();});
      req.pipe(upstream);return;
    }
    if(!['GET','HEAD'].includes(req.method))return reply(res,405,{});
    if(base && url.pathname==='/' && !String(req.headers.cookie||'').includes('wakuku_invite=')){
      res.writeHead(302,{...common,location:'/broker/auth/invite','cache-control':'no-store'});res.end();return;
    }
    const file=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
    if(!file.startsWith(root+path.sep))return reply(res,403,{});
    const actual=await realpath(file);
    if(!actual.startsWith(root+path.sep))return reply(res,403,{});
    const info=await stat(actual);if(!info.isFile())return reply(res,404,{});
    let start=0,end=info.size-1,status=200;
    const headers={...common,'content-type':mime[path.extname(file)]||'application/octet-stream',
      'accept-ranges':'bytes','cache-control':/\.(html|json)$/.test(file)?'no-cache':'public,max-age=86400'};
    if(req.headers.range){
      const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      if(!m)return reply(res,416,{});
      start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),end):end;
      if(start>end || start>=info.size)return reply(res,416,{});
      status=206;headers['content-range']=`bytes ${start}-${end}/${info.size}`;
    }
    headers['content-length']=end-start+1;res.writeHead(status,headers);
    if(req.method==='HEAD')return res.end();
    const stream=createReadStream(actual,{start,end});stream.pipe(res);
    res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());
  }catch{if(!res.headersSent)reply(res,404,{error:'not_found'});else res.destroy();}
});
server.on('upgrade',(req,socket,head)=>{
  if(!base)return cloud.upgrade(req,socket,head);
  if(!configured() || req.headers.origin!==origin || !['/broker/local/chat/turn','/broker/local/interaction/turn'].includes(req.url))return socket.destroy();
  const upstream=client.request(options(req,req.url.slice('/broker'.length)));
  upstream.on('upgrade',(r,peer,peerHead)=>{
    let response='HTTP/1.1 101 Switching Protocols\r\n';
    for(const key of ['upgrade','connection','sec-websocket-accept','sec-websocket-protocol'])if(r.headers[key])response+=`${key}: ${r.headers[key]}\r\n`;
    socket.write(response+'\r\n');if(peerHead.length)socket.write(peerHead);if(head.length)peer.write(head);
    socket.pipe(peer);peer.pipe(socket);
    peer.on('error',()=>socket.destroy());socket.on('error',()=>peer.destroy());
    socket.on('close',()=>peer.destroy());peer.on('close',()=>socket.destroy());
  });
  upstream.on('response',()=>socket.destroy());upstream.on('timeout',()=>upstream.destroy());
  upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy());upstream.end();
});
server.requestTimeout=120000;
server.listen(Number(process.env.PORT)||8080,process.env.BIND_HOST||'0.0.0.0',()=>console.info('wakuku_gateway_ready; no credentials logged'));
