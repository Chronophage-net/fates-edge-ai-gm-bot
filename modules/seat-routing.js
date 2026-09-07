'use strict';
const GM_ROLES = new Set(['gm', 'co-gm', 'assistant-gm']);
const gmLike = role => GM_ROLES.has(role);
function responder(text, roster) {
  const parts = text.match(/"[^"]*"|\S+/g) || [];
  const [prefix, command, verb, ...rest] = parts.map(s => s.replace(/^"|"$/g, ''));
  if (prefix !== '!gm') return null;
  const seats = roster.filter(c => c.botMode).sort((a,b)=>a.botSeat-b.botSeat || a.id.localeCompare(b.id));
  const gm = seats.find(c => c.botMode === 'gm');
  if (command === 'player') {
    if (verb === 'new') return seats.find(c=>c.botMode==='player' && !c.botCharacter && !c.botBusy)?.id || gm?.id;
    if (['seats','list'].includes(verb)) return (gm || seats[0])?.id;
    const name = rest.join(' ').toLowerCase();
    return seats.filter(c=>c.botMode==='player' && c.botCharacter && (name===c.botCharacter.toLowerCase() || name.startsWith(c.botCharacter.toLowerCase()+' '))).sort((a,b)=>b.botCharacter.length-a.botCharacter.length)[0]?.id || gm?.id;
  }
  if (['ask','look','quickref','recap','sheet','name','dice','roll'].includes(command) || command==='deck' && verb==='draw') return (gm || seats.find(c=>c.botMode==='passive'))?.id;
  return gm?.id;
}
module.exports = { responder, gmLike };
