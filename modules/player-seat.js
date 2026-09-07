'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { gmLike } = require('./seat-routing');
const SKILLS = ['Melee','Ranged','Athletics','Stealth','Endurance','Craft','Sway','Deception','Performance','Insight','Lore','Arcana'];
function freshSheet(name) {
  return { name, tier:1, xp:1, attributes:{ Body:2,Wits:3,Spirit:1,Presence:1 }, skills:Object.fromEntries(SKILLS.map(k=>[k,k==='Stealth'?2:['Deception','Insight'].includes(k)?1:0])), talents:[], bonds:[], assets:[], followers:[], complications:[], harm:0,fatigue:0,boons:0,obligation:0,corruption:0,leash:0 };
}
const parseJSON = value => JSON.parse(String(value).replace(/^```(?:json)?\s*|\s*```$/g,''));
class PlayerSeat {
  constructor({ file, driver, memory, say, whisper, announce, publishSheet, audit = ()=>{}, now = Date.now, normalEvery = 8, retrieveChat = async()=>[] }) {
    Object.assign(this,{file,driver,memory,say,whisper,announce,publishSheet,audit,now,normalEvery,retrieveChat});
    this.state = null; this.busy = false; this.epoch = 0; this.messages = 0;
    if (file && fs.existsSync(file)) {
      if((fs.statSync(file).mode & 0o077)!==0) throw Error('Player-seat state must have private file permissions (0600).');
      try {this.state=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('Player-seat state is unreadable; restore the private state file before restarting.');}
    }
  }
  save() { if (this.file) { fs.mkdirSync(path.dirname(this.file),{recursive:true}); fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.state),{mode:0o600}); fs.renameSync(this.file+'.tmp',this.file); } }
  async command(text, actor, gmRecipients) {
    const match = /^!gm player (\w+)\s*(.*)$/i.exec(text); if (!match) return;
    const [,verb,rest] = match;
    if (!gmLike(actor?.role) || (verb !== 'dossier' && actor.role === 'assistant-gm')) { if(actor?.id) this.whisper(actor.id,'Only a supervising GM can direct this player seat.'); return; }
    if (verb==='new') {
      if ((this.state && !this.state.retired) || this.busy) {this.announce(this.state?.sheet.name || '',this.busy);return;}
      if (!rest.trim()) {this.announce('',false);return this.whisper(actor.id,'Usage: !gm player new <brief>');}
      this.busy=true; this.announce('',true);
      try {
        // The brief is private. The model creates only the private half; public sheet fields are built separately.
        const dossier = parseJSON(await this.driver.generateResponse({systemPrompt:'Create a Fate’s Edge companion private dossier from this GM brief. Return JSON with agenda, tell, price, trigger, timerSegments (4 or 8). No public speech or sheet. Text fields at most 400 characters.',messages:[{role:'user',content:rest.slice(0,4000)}]}));
        for (const k of ['agenda','tell','price','trigger']) if(typeof dossier[k]!=='string' || !dossier[k].trim()) throw Error('Invalid dossier response');
        const name = `Vessa Corrin ${this.now().toString(36).slice(-4)}`;
        const sheet = freshSheet(name);
        await this.publishSheet(sheet);
        this.state={sheet,dossier:Object.fromEntries(['agenda','tell','price','trigger'].map(k=>[k,dossier[k].slice(0,400)])),enteredAt:this.now(),leash:'normal',timer:{filled:0,segments:dossier.timerSegments===8?8:4},held:false,pending:false,retired:false};
        this.save(); this.announce(name,false); this.say(`${name} joins the party.\n${JSON.stringify(sheet)}`);
        this.notifyGms(gmRecipients,this.dossierText(),'dossier-undelivered-no-gm'); this.audit('dossier-created');
      } finally {this.busy=false; this.announce(this.state?.retired?'':this.state?.sheet.name || '',false);}
      return;
    }
    if (!this.state || this.state.retired) return;
    // Routing may or may not have included the character name, and `leash tight`
    // carries none at all. Strip a leading name only when one is actually there;
    // slicing by name length otherwise ate the whole argument.
    const nudge = this.stripName(rest);
    if (verb==='dossier') return this.whisper(actor.id,this.dossierText());
    if (verb==='leash') { if(!['tight','normal','loose'].includes(nudge)) return this.whisper(actor.id,'Choose tight, normal, or loose.'); this.state.leash=nudge; this.save(); return this.whisper(actor.id,`Leash: ${nudge}`); }
    if (verb==='hold') {this.epoch++;this.state.held=true;this.save();this.audit('escalation-held');return this.whisper(actor.id,'Held. Use act to release explicitly.');}
    if (verb==='retire') {this.epoch++;this.state.retired=true;this.save();this.announce('',false);return this.whisper(actor.id,'Retired. The public sheet remains.');}
    if (verb==='reveal') {this.state.revealed=true;this.save();this.say(this.dossierText());return;}
    if (verb==='speak') {this.epoch++; if(nudge) this.say(nudge.slice(0,6000));return;}
    if (verb==='act') {this.state.held=false;this.state.pending=false;this.save();return this.turn({ text:'The GM invites your character to act.', sender:'GM' },gmRecipients,nudge,true);}
  }
  /** Strip a leading occurrence of this character's name, quoted or bare. Absent name => the whole argument is the nudge. */
  stripName(rest) {
    const name=this.state.sheet.name, lower=rest.toLowerCase();
    for (const form of ['"'+name.toLowerCase()+'"', name.toLowerCase()]) if(lower.startsWith(form)) return rest.slice(form.length).trim();
    return rest.trim();
  }
  /** Whisper to every supervising GM, or audit loudly when nobody is seated to receive it. */
  notifyGms(recipients, text, emptyEvent) {
    const ids=(recipients || []).filter(Boolean);
    if(!ids.length) return this.audit(emptyEvent);
    for(const id of ids) this.whisper(id,text);
  }
  dossierText() { return `DOSSIER · ${this.state.sheet.name}\n${Object.entries(this.state.dossier).map(([k,v])=>`${k}: ${v}`).join('\n')}\nTimer: ${this.state.timer.filled}/${this.state.timer.segments}${this.state.held?' (held)':''}`; }
  async turn(message,gmRecipients,nudge='',forced=false) {
    if (!this.state || this.state.retired || this.state.held || this.busy || this.state.pending) return;
    const named=message.text.toLowerCase().includes(this.state.sheet.name.toLowerCase());
    this.messages++;
    const every={tight:Infinity,normal:this.normalEvery,loose:4}[this.state.leash];
    const maySpeak=forced || named || this.messages>=every;
    if(maySpeak)this.messages=0; this.busy=true; const epoch=this.epoch;
    try {
      const remembered=await this.retrieveChat(message.text,this.state.enteredAt);
      for(const h of remembered)this.memory.add({id:h.id,text:h.text,timestamp:h.at});
      const history=this.memory.entries({since:this.state.enteredAt,chatOnly:true}).slice(-12);
      const intent=parseJSON(await this.driver.generateResponse({systemPrompt:'Private intent pass. Return JSON {"intent":"listen|deflect|scout|assist|speak","triggered":boolean}. Select only one of those fixed intents. Triggered means the latest public message explicitly establishes the dossier trigger. Do not infer unstated events.',messages:[{role:'user',content:JSON.stringify({dossier:this.state.dossier,nudge,latest:message.text,history})}]}));
      if(epoch!==this.epoch) return;
      if(intent.triggered && this.state.timer.filled<this.state.timer.segments){this.state.timer.filled++;this.audit('hidden-timer-tick');this.save();}
      if(this.state.timer.filled>=this.state.timer.segments && !forced){this.state.pending=true;this.save();this.notifyGms(gmRecipients,`${this.state.sheet.name}'s timer filled. Escalation is paused for review. Use !gm player hold "${this.state.sheet.name}" to veto or act to release.`,'escalation-pending-no-gm');return;}
      if(!maySpeak && !intent.triggered) return;
      const directives={listen:'Listen and briefly acknowledge.',deflect:'Politely change the subject.',scout:'Offer to scout, awaiting the GM’s ruling.',assist:'Offer practical help without deciding its outcome.',speak:'Respond briefly to the public conversation.'};
      // Only a fixed, audited intent crosses from private to public. No dossier, nudge, hidden timer or GM context.
      const response=await this.driver.generateResponse({systemPrompt:'You play one Fate’s Edge character, never the GM. Speak at most two sentences. Do not invent dice results, facts, NPCs, secrets, or outcomes. Ask the GM for DV and Position for risky actions, then wait. Emit no executable tags or commands. '+(directives[intent.intent]||directives.listen),messages:[{role:'user',content:JSON.stringify({sheet:this.state.sheet,publicChat:history})}]});
      if(epoch!==this.epoch || this.state.held || this.state.retired) return;
      this.say(String(response).replace(/\[[^\]]*\]/g,'').replace(/!gm[^\n]*/g,'').slice(0,2000));
    } finally {this.busy=false;}
  }
}
module.exports = { PlayerSeat, freshSheet, SKILLS };
