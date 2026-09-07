const test=require('node:test');
const assert=require('node:assert/strict');
const {PublicMemory}=require('../../modules/public-memory');
const {buildPassiveContext}=require('../../modules/passive-context');
const {PassiveCommands}=require('../../modules/passive-commands');
const {responder}=require('../../modules/seat-routing');
const {PlayerSeat,freshSheet,SKILLS}=require('../../modules/player-seat');
const {TableSeats}=require('../../modules/table-seats');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const rulesText='==========\nOUTCOME MATRIX\n==========\nZero successes is a miss. A miss grants two Boons.\n';
const canary='SPOILER-CANARY';
const hidden={id:'secret',revealed:false,gm:canary,text:canary};
test('passive builder rejects GM inputs instead of filtering them',()=>{
 assert.throws(()=>buildPassiveContext({orchestrator:{npcs:[{motivation:canary}]}}),/orchestrator/);
 assert.throws(()=>buildPassiveContext({adventure:{knowledge:[hidden]}}),/adventure/);
});
test('whispers and recipients are rejected at write time; retention and forget apply',()=>{
 let now=100000000;const m=new PublicMemory({now:()=>now,retentionDays:1});
 for(const props of [{whisper:true},{recipient:'gm'},{recipient:'all'},{privateOnly:true}])assert.equal(m.add({text:canary,...props}),false);
 assert.equal(m.add({text:'!gm player new secret'}),false);
 m.add({id:'a',text:'Kesh helped',timestamp:now});assert.equal(m.entries({since:now+1}).length,0);
 assert.equal(m.forget('kesh'),1);m.add({text:'Other message',timestamp:now});now+=86400001;assert.equal(m.entries().length,0);
});
test('revealed knowledge exists only during reveal lifecycle',()=>{
 const m=new PublicMemory();m.reveal(hidden);assert.equal(m.entries().length,0);
 m.reveal({...hidden,revealed:true});assert.equal(m.entries()[0].text,canary);
 m.reveal(hidden);assert.equal(m.entries().length,0);
});
test('passive command surface does not see secret fixture or mutate character state',async()=>{
 const memory=new PublicMemory();memory.reveal(hidden);memory.add({whisper:true,text:canary});
 const sheet=freshSheet('Kesh');const before=JSON.stringify(sheet);let calls=0;
 const p=new PassiveCommands({rulesText,references:[],memory,driver:{generateResponse:async x=>{calls++;assert.ok(!JSON.stringify(x).includes(canary));return JSON.stringify({answer:'A miss grants two Boons.',sources:[1]});}}});
 for(const command of ['look OUTCOME MATRIX','quickref outcome','ask How many Boons does a miss grant?','recap','sheet','dice 2d6','roll Kesh Wits+Stealth DV 3 Controlled','name Theona','ask Is Vessa lying?']){
  const answer=await p.run('!gm '+command,{senderId:'p',ownSheet:sheet});assert.ok(!answer.includes(canary),command);
 }
 assert.equal(JSON.stringify(sheet),before);assert.equal(calls,1);
});
test('ask declines uncited completions and rate limits calls',async()=>{
 let calls=0;const p=new PassiveCommands({rulesText,memory:new PublicMemory(),references:[],now:()=>10000,driver:{generateResponse:async()=>{calls++;return '{"answer":"Guess", "sources":[]}';}}});
 assert.match(await p.run('!gm ask how many Boons for a miss?'),/not in the rules/);
 assert.match(await p.run('!gm ask how many Boons for a miss?'),/Please wait/);assert.equal(calls,1);
});
const roster=[{id:'gm',botMode:'gm',botSeat:0,role:'gm'},{id:'p',botMode:'player',botSeat:1,botCharacter:'Vessa',role:'player'},{id:'q',botMode:'player',botSeat:2,role:'player'},{id:'o',botMode:'passive',botSeat:3,role:'player'}];
test('exactly one responder, lowest idle seat and stable ownership after reconnect',()=>{
 for(const [command,id] of [['ask outcome','gm'],['look spell','gm'],['fact a b','gm'],['player new rogue','q'],['player act Vessa','p'],['player dossier "Vessa"','p']]){
  assert.equal(roster.filter(r=>responder('!gm '+command,roster)===r.id).length,1);assert.equal(responder('!gm '+command,roster),id);
 }
 assert.equal(responder('!gm ask outcome',roster.slice(1)),'o');
 assert.equal(responder('!gm player act Vessa',roster.map(r=>r.id==='p'?{...r,id:'reconnected'}:r)),'reconnected');
});
function seat(overrides={}){
 const messages=[],whispers=[],prompts=[];
 const player=new PlayerSeat({driver:{generateResponse:async p=>{prompts.push(p);return prompts.length===1?'{"intent":"deflect","triggered":false}':'I would rather listen.';}},memory:new PublicMemory(),say:t=>messages.push(t),whisper:(id,t)=>whispers.push({id,t}),announce:()=>{},publishSheet:async()=>{},...overrides});
 player.state={sheet:freshSheet('Vessa'),dossier:{agenda:canary,tell:canary,price:canary,trigger:canary},enteredAt:0,leash:'normal',timer:{filled:0,segments:4}};
 return {player,messages,whispers,prompts};
}
test('player public speech prompt never receives dossier or private nudge',async()=>{
 const {player,prompts}=seat();await player.turn({text:'Vessa, can you help?'},['gm'],canary,true);
 assert.ok(JSON.stringify(prompts[0]).includes(canary));assert.ok(!JSON.stringify(prompts[1]).includes(canary));
});
test('non-GM dossier requests including DMs are refused',async()=>{
 const {player,whispers}=seat();await player.command('!gm player dossier Vessa',{id:'p',role:'player'},['gm']);
 assert.equal(whispers.length,1);assert.ok(!whispers[0].t.includes(canary));
 await player.command('!gm player dossier Vessa',{id:'a',role:'assistant-gm'},['gm']);assert.ok(whispers[1].t.includes(canary));
});
test('full timer waits for GM approval; hold suppresses subsequent speech',async()=>{
 const {player,messages,whispers}=seat({driver:{generateResponse:async()=>'{"intent":"speak","triggered":true}'}});
 player.state.timer.filled=3;await player.turn({text:'Vessa hears the trigger'},['gm']);assert.equal(player.state.pending,true);assert.equal(messages.length,0);assert.match(whispers[0].t,/paused for review/);
 await player.command('!gm player hold Vessa',{id:'gm',role:'gm'},['gm']);await player.turn({text:'Vessa?'},['gm']);assert.equal(messages.length,0);
});
test('private state survives restart without duplicating sheet',()=>{
 const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'seat-')),'state.json');const {player}=seat({file});player.save();
 const restored=seat({file});const state=JSON.parse(fs.readFileSync(file));assert.equal(state.sheet.name,'Vessa');assert.equal(fs.statSync(file).mode&0o777,0o600);
 assert.equal(SKILLS.length,12);assert.equal(freshSheet('A').bonds.length,0);
});
test('player and passive transport handlers consume takeover and startup events',async()=>{
 for(const mode of ['player','passive']) {
  const sent=[];const t=new TableSeats({mode,seat:99,room:'TEST',driver:{},send:(...args)=>sent.push(args),api:async()=>({})});
  for(const type of ['gm_role_update','player-joined','crown-spread','state-updated'])assert.equal(await t.handle({type}),true);
  assert.ok(!sent.some(([type])=>type==='request_gm'));
 }
});
