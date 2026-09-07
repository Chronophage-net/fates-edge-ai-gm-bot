'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { legacyRoomId } = require('./room-identity');
const { PublicMemory } = require('./public-memory');
const { PassiveCommands, SAFE } = require('./passive-commands');
const { loadReferences } = require('./passive-context');
const { PlayerSeat } = require('./player-seat');
const { responder, gmLike } = require('./seat-routing');
const knowledgeIndex=require('./knowledge-index');
const verbIsPlayer = text => /^!gm\s+player\b/i.test(text);
function readRules(){try{return fs.readFileSync(path.join(__dirname,'../data/rules.txt'),'utf8');}catch{return '';}}
class TableSeats {
  constructor({ mode='gm', seat=0, room, roomId, driver, send, api, disconnect=()=>{}, audit=()=>{} }) {
    if(!['gm','player','passive'].includes(mode)) throw Error('MODE must be gm, player, or passive');
    Object.assign(this,{mode,seat,room,driver,send,api,audit,disconnect}); this.roomId=(roomId || legacyRoomId(room)).toLowerCase();this.roster=[];this.id=null;
    this.forgotten=[];this.turnQueue=Promise.resolve();this.queuedTurns=0;this.identityRejected=false;
    this.memory=new PublicMemory({retentionDays:Number(process.env.CHAT_RETENTION_DAYS)||30});
    this.passive=new PassiveCommands({rulesText:readRules(),references:loadReferences(),memory:this.memory,driver,audit,threshold:Number(process.env.ASK_MIN_SCORE)||0.4});
    this.player=mode==='player'?new PlayerSeat({file:path.join(__dirname,'../campaigns/seats',`${this.roomId}-${seat}.json`),driver,memory:this.memory,audit,
      retrieveChat:(query,since)=>knowledgeIndex.searchPublic(this.roomId,query,{since,chatOnly:true}),
      say:text=>this.say(text),whisper:(id,text)=>this.whisper(id,text),announce:(character,busy)=>this.announce(character,busy),
      publishSheet:async sheet=>{await api('POST',['characters','update'],{updates:{[sheet.name]:sheet}});}
    }):null;
  }
  name() {return this.player?.state?.sheet?.name || (this.mode==='gm'?'GM':`AI ${this.mode} ${this.seat}`);}
  say(text) {this.send('chat-message',{message:{sender:this.name(),text:String(text),timestamp:Date.now(),id:require('node:crypto').randomUUID()}});}
  whisper(id,text) {if(id)this.send('chat-message',{message:{sender:this.name(),text:String(text),timestamp:Date.now(),whisper:true,privateOnly:true,recipient:id}});}
  announce(character=this.player?.state?.retired?'':this.player?.state?.sheet.name || '',busy=false) {
    const own=this.roster.find(c=>c.id===this.id); if(own) Object.assign(own,{botCharacter:character,botBusy:busy});
    this.send('bot-seat',{character,busy});
  }
  async refreshPublic() {
    // Dedicated endpoint projects revealed entries only; no adventure/reference API is reachable here.
    try {const value=await this.api('GET',['public-context']);this.memory.replaceRevealed(value.knowledge || []);for(const m of value.chat || [])if(!this.forgotten.some(q=>m.text?.toLowerCase().includes(q)))this.memory.add(m);
      // Retrieval of revealed truth uses the just-fetched live projection, not stale ES hits.
      if(this.mode==='gm') await knowledgeIndex.syncRevealed(this.roomId,value.knowledge||[]).catch(()=>{});}
    // A transient failure must not erase revealed truth: keeping the last good
    // projection is strictly safer than answering DECLINE for facts the table has.
    catch {this.audit('public-context-refresh-failed');}
  }
  async handle(msg) {
    if(this.identityRejected)return true;
    if(msg.type==='handshake_ack') {
      this.id=msg.clientId;this.roster=msg.activeClients || [];
      if(msg.room_id && msg.room_id!==this.roomId) {this.identityRejected=true;this.audit('room-identity-mismatch');this.disconnect();return true;}
      if(this.mode!=='gm' && !this.roster.some(c=>c.id===this.id&&c.botMode===this.mode)){this.identityRejected=true;this.audit('seat-registration-rejected-check-API_KEY');this.disconnect();return true;}
      this.announce(); void knowledgeIndex.prunePublic(this.roomId); return this.mode!=='gm';
    }
    if(msg.type==='room-code-rotated' && msg.room_id===this.roomId){this.room=msg.room_code;return true;}
    if(msg.type==='public-memory-forgotten'){this.forgotten.push(String(msg.query).toLowerCase());this.memory.forget(msg.query);return true;}
    if(msg.type==='presence'){this.roster=msg.clients || [];return this.mode!=='gm';}
    if(!['chat-message','chat_message'].includes(msg.type)) return this.mode!=='gm';
    const chat=msg.message || msg.value || msg;
    const actor=this.roster.find(c=>c.id===chat.senderClientId);
    if(!chat.text || chat.senderClientId===this.id) return this.mode!=='gm';
    // Transport identity only: a name saying "GM" confers no authority.
    const publicChat=!chat.whisper && !chat.privateOnly && (!chat.recipient || chat.recipient==='all');
    if(publicChat && !this.forgotten.some(q=>chat.text.toLowerCase().includes(q))) {
      const clean={...chat,recipient:undefined}; this.memory.add(clean);
      if(this.mode==='gm') void knowledgeIndex.indexChat(this.roomId,clean);
    }
    const text=chat.text.trim();const gmIds=this.roster.filter(c=>gmLike(c.role) && !c.botMode).map(c=>c.id);
    if(!text.startsWith('!gm')) {
      if(publicChat && !actor?.botMode && this.player && this.queuedTurns<20) {
        this.queuedTurns++;this.turnQueue=this.turnQueue.then(()=>this.player.turn(chat,gmIds)).catch(()=>this.audit('player-turn-failed')).finally(()=>this.queuedTurns--);
      }
      return this.mode!=='gm';
    }
    const chosen=chat.privateOnly && chat.recipient===this.id && verbIsPlayer(text) ? this.id : responder(text,this.roster);
    if(chosen && chosen!==this.id) return true;
    if(!chosen && this.mode!=='gm') return true;
    const [,verb,sub]=text.split(/\s+/);
    if(verb==='player') {
      if(!gmLike(actor?.role)){this.whisper(actor?.id,'Only a GM or Assistant GM can inspect player seats.');return true;}
      if(['seats','list'].includes(sub)) {this.whisper(actor.id,this.roster.filter(c=>c.botMode).map(c=>`${c.botSeat}: ${c.botMode} — ${c.botCharacter || (c.botBusy?'creating':'idle')}`).join('\n'));return true;}
      if(this.player){void this.player.command(text,actor,gmIds).catch(e=>this.whisper(actor.id,`Player-seat request failed: ${e.message}`));}
      else this.whisper(actor.id,sub==='new'?'No idle player seat. Add a player entry to bots.json.':'No player seat owns that character.');return true;
    }
    if(verb==='forget') {
      if(!gmLike(actor?.role)){this.whisper(actor?.id,'Only the GM can forget public memory.');return true;}
      const query=text.split(/\s+/).slice(2).join(' ').trim();
      if(!query)return this.whisper(actor.id,'Usage: !gm forget <query>'),true;
      await this.api('POST',['public-memory','forget'],{query});
      await knowledgeIndex.forgetPublic(this.roomId,query);
      this.forgotten.push(query.toLowerCase());const count=this.memory.forget(query);this.whisper(actor.id,`Forgot matching public messages (${count} in local memory).`);return true;
    }
    if(SAFE.has(verb) && !(this.mode==='gm' && ['dice','roll'].includes(verb))) {
      await this.refreshPublic();
      const hits=await knowledgeIndex.searchPublic(this.roomId,text.split(/\s+/).slice(2).join(' ')||'session',{chatOnly:true});
      for(const hit of hits)if(!this.forgotten.some(q=>hit.text.toLowerCase().includes(q)))this.memory.add({id:hit.id,text:hit.text,timestamp:hit.at});
      let ownSheet=null;
      if(actor?.id){try{ownSheet=await this.api('GET',['public-sheet',encodeURIComponent(actor.id)]);}catch{}}
      try {const answer=await this.passive.run(text,{senderId:actor?.userId || actor?.id || 'anonymous',ownSheet});if(answer){if(verb==='roll')this.say(answer);else if(!publicChat)this.whisper(actor?.id,answer);else this.say(answer);}}
      catch {this.whisper(actor?.id,'The reference service is unavailable. Try !gm look.');}return true;
    }
    if(this.mode==='passive' && verb==='deck' && sub==='draw'){this.send('deck-draw',{count:1});return true;}
    if(this.mode!=='gm')return true;
    // New GM-only commands must be authorized by the human sender, not this bot's role.
    if(['recall','knowledge','fact','approve','reject','confirm-takeover','create','delete','load','seed','spend'].includes(verb) && !gmLike(actor?.role)) {
      this.whisper(actor?.id,'Only the GM or Assistant GM may use that command.');return true;
    }
    return false;
  }
}
module.exports={TableSeats};
