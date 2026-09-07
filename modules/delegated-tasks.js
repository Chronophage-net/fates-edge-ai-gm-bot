'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const HELP = `Delegated side tasks (signed-in human GM and players):
!gm delegate players — show account IDs in this room
!gm delegate start <id,id> "task, context and limits"
!gm delegate list
!gm delegate status|pause|resume|finish|accept|cancel <task-id>
!gm delegate instruct <task-id> "new instruction"
Players use a second client in the invited room; !task done asks for completion, !task pause requests a pause. Accept adds the reviewed recap to the main conversation; character/stat changes remain manual.`;
const terminal = new Set(['accepted', 'cancelled']);
class DelegatedTasks {
    constructor({ url, room, driver, source, file, acceptOutcome, socketFactory = url => new WebSocket(url) }) {
        Object.assign(this, { url, room, driver, source, file, acceptOutcome, socketFactory });
        this.tasks = new Map(); this.pending = new Map(); this.roster = []; this.supported = false;
        if (file && fs.existsSync(file)) {
            const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
            for (const task of saved) {
                if (!terminal.has(task.status) && task.status !== 'awaiting-review') task.status = 'paused';
                delete task.opening; delete task.busy;
                this.tasks.set(task.id, task);
            }
        }
    }
    save() {
        if (!this.file) return;
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const serialized = [...this.tasks.values()].map(({ socket, busy, epoch, opening, ...task }) => task);
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(serialized, null, 2), { mode: 0o600 });
        fs.renameSync(this.file + '.tmp', this.file);
    }
    request(data) {
        const socket = this.source();
        if (!this.supported || !socket || socket.readyState !== 1) return Promise.reject(new Error('Connect to an updated side-task-capable server first.'));
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Side-task server request timed out.')); }, 8000);
            this.pending.set(requestId, { resolve, reject, timer });
            try { socket.send(JSON.stringify({ type: 'side-task', requestId, ...data })); }
            catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
        });
    }
    privateReply(clientId, text) {
        const socket = this.source();
        if (socket?.readyState === 1) socket.send(JSON.stringify({ type: 'chat-message', message: {
            text: String(text).slice(0, 12000), sender: 'Side-task GM', whisper: true, privateOnly: true, recipient: clientId, timestamp: Date.now()
        } }));
    }
    async report(task, text) {
        task.lastReport = String(text).slice(0, 10000); this.save();
        try { await this.request({ action: 'report', taskId: task.id, delegationToken: task.token, text: `[Side task ${task.id} — ${task.status}]\n${task.lastReport}` }); }
        catch { /* Retain the report for !gm delegate status after reconnect. */ }
    }
    async handleSource(msg) {
        if (msg.type === 'side-task-ack') {
            const entry = this.pending.get(msg.requestId);
            if (entry) { clearTimeout(entry.timer); this.pending.delete(msg.requestId); msg.success ? entry.resolve(msg) : entry.reject(new Error(msg.error || 'Side task rejected.')); }
            return true;
        }
        if (msg.type === 'handshake_ack') { this.supported = msg.sideTasks === true; this.roster = msg.activeClients || []; }
        if (msg.type === 'presence' && Array.isArray(msg.clients)) this.roster = msg.clients;
        const chat = msg.message || msg.value || msg;
        if (!['chat-message', 'chat_message'].includes(msg.type) || !/^!gm\s+delegate\b/i.test(chat.text || '')) return false;
        // These fields are overwritten by both server transports, never inferred from a display name.
        if (chat.verifiedGM !== true || !chat.senderUserId || !chat.senderClientId) {
            if (chat.senderClientId) this.privateReply(chat.senderClientId, 'Delegation requires a signed-in human GM.');
            return true;
        }
        try { this.privateReply(chat.senderClientId, await this.command(chat)); }
        catch (error) { this.privateReply(chat.senderClientId, error.message); }
        return true;
    }
    async command(chat) {
        const parts = (chat.text.match(/"[^"]*"|\S+/g) || []).slice(2).map(s => s.replace(/^"|"$/g, ''));
        const [action, id, ...rest] = parts;
        const owner = String(chat.senderUserId);
        if (!action || action === 'help') return HELP;
        if (action === 'players') return this.roster.filter(c => c.userId).map(c => `${c.name}: ${c.userId}`).join('\n') || 'No signed-in players are present.';
        if (action === 'list') return [...this.tasks.values()].filter(t => t.supervisor === owner).map(t => `${t.id}: ${t.status} — ${t.room || 'not connected'}`).join('\n') || 'No delegated tasks.';
        if (action === 'start') {
            if ([...this.tasks.values()].filter(t => !terminal.has(t.status)).length >= 3) throw new Error('Finish or cancel an existing task first (limit: 3).');
            if (this.tasks.size >= 100) throw new Error('Delegation history limit reached; archive the task file while the bot is stopped.');
            const participants = [...new Set((id || '').split(',').filter(Boolean))];
            const brief = rest.join(' ').trim();
            if (!brief || brief.length > 6000 || !participants.length || participants.length > 8) throw new Error(HELP);
            const task = { id: randomBytes(6).toString('hex'), supervisor: owner, participants, brief, status: 'paused', history: [], turns: 0, createdAt: new Date().toISOString() };
            this.tasks.set(task.id, task); this.save();
            try { await this.open(task, chat.senderClientId); }
            catch (error) { task.status = 'paused'; this.save(); throw new Error(`Task ${task.id} paused: ${error.message}. Resume or cancel it.`); }
            return `Task ${task.id} started in ${task.room}. Private invitations sent. Use a second client so the original room keeps running.`;
        }
        const task = this.tasks.get(id);
        if (!task || task.supervisor !== owner) throw new Error('Task not found for this supervising GM.');
        if (action === 'status') return `${task.id}: ${task.status}\nRoom: ${task.room || 'none'}\n${task.lastReport || task.brief}\n${task.summary || ''}`;
        if (action === 'pause' && task.status === 'active') { this.pause(task); await this.report(task, 'Paused by supervising GM.'); return 'Paused.'; }
        if (action === 'resume' && task.status === 'paused') { await this.open(task, chat.senderClientId); return `Resumed ${task.id} in ${task.room}.`; }
        if (action === 'instruct' && ['active', 'paused'].includes(task.status)) {
            const instruction = rest.join(' ').trim();
            if (!instruction || instruction.length > 6000) throw new Error('Supply an instruction up to 6,000 characters.');
            task.brief = (task.brief + '\nGM instruction: ' + instruction).slice(-12000); this.save();
            await this.report(task, 'Supervising GM updated the instructions.'); return 'Instructions updated.';
        }
        if (action === 'finish' && ['active', 'paused'].includes(task.status)) { await this.finish(task); return `Recap ready. Review with !gm delegate status ${id}; accept with !gm delegate accept ${id}.`; }
        if (action === 'accept' && task.status === 'awaiting-review') {
            await this.acceptOutcome(task); task.status = 'accepted'; this.save();
            return 'Reviewed recap added to the main campaign conversation. Apply any character/stat changes through the normal GM controls.';
        }
        if (action === 'cancel' && !terminal.has(task.status)) {
            this.pause(task); task.status = 'cancelled'; this.save(); await this.closeRoom(task);
            return 'Cancelled. No outcome was applied to the main campaign.';
        }
        throw new Error(`Cannot ${action} a task in ${task.status}.\n${HELP}`);
    }
    async open(task, supervisorClientId) {
        if (task.opening) throw new Error('A connection attempt is already in progress.');
        task.opening = true;
        const openingEpoch = task.epoch = (task.epoch || 0) + 1;
        try {
            const result = await this.request({ action: 'open', taskId: task.id, supervisorClientId, participants: task.participants, delegationToken: task.token });
            task.room = result.room; task.token = result.delegationToken; this.save();
            if (task.epoch !== openingEpoch || terminal.has(task.status)) { await this.closeRoom(task); throw new Error('Connection attempt cancelled.'); }
            await this.connectSide(task);
            await this.request({ action: 'invite', taskId: task.id, delegationToken: task.token });
            await this.report(task, `Side room ${task.room} ready. Brief: ${task.brief}`);
        } finally { delete task.opening; this.save(); }
    }
    connectSide(task) {
        task.socket?.close();
        const url = new URL(this.url); url.searchParams.set('room', task.room);
        const socket = this.socketFactory(url.toString()); task.socket = socket;
        const epoch = task.epoch = (task.epoch || 0) + 1;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pause(task); reject(new Error('Side-room handshake timed out.')); }, 8000);
            socket.on('open', () => socket.send(JSON.stringify({ type: 'handshake', clientName: `Side-task GM ${task.id}`, role: 'gm', sideTaskId: task.id, delegationToken: task.token })));
            socket.on('message', raw => {
                let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
                if (task.epoch !== epoch) return;
                if (msg.type === 'handshake_ack') {
                    clearTimeout(timer);
                    if (!msg.success || msg.sideTaskId !== task.id) { this.pause(task); reject(new Error('Server did not confirm a protected side room.')); return; }
                    task.status = 'active'; this.save();
                    this.say(task, `Delegated task: ${task.brief}\nUse !task done when ready for a recap, or !task pause to stop. Main-campaign changes need human GM review.`);
                    resolve(); return;
                }
                if (msg.type === 'chat-message' && task.status === 'active') {
                    const chat = msg.message || msg;
                    if (task.participants.includes(String(chat.senderUserId))) {
                        this.playerTurn(task, chat).catch(() => { this.pause(task); void this.report(task, 'An AI or connection error paused this task. Resume when ready.'); });
                    }
                }
            });
            const disconnected = () => {
                clearTimeout(timer);
                if (task.epoch !== epoch) return;
                this.pause(task); void this.report(task, 'Side-room connection lost. Task paused; use resume.');
                reject(new Error('Side-room connection lost.'));
            };
            socket.on('close', disconnected); socket.on('error', disconnected);
        });
    }
    say(task, text) {
        if (task.socket?.readyState === 1) task.socket.send(JSON.stringify({ type: 'chat-message', message: {
            sender: `Side-task GM ${task.id}`, text: String(text).slice(0, 12000), timestamp: Date.now()
        } }));
    }
    pause(task) {
        task.epoch = (task.epoch || 0) + 1;
        if (task.status === 'active') task.status = 'paused';
        const socket = task.socket; delete task.socket; socket?.close(); this.save();
    }
    async playerTurn(task, chat) {
        const text = String(chat.text || '').trim();
        if (!text || text.length > 6000) return;
        if (/^!task pause\b/i.test(text)) { this.pause(task); await this.report(task, 'A participant requested a pause.'); return; }
        if (task.busy) { this.say(task, 'Please wait for the current response, then send your action again.'); return; }
        if (/^!task done\b/i.test(text)) { task.history.push({ role: 'user', content: text }); await this.finish(task); return; }
        if (task.turns >= 40) { this.pause(task); await this.report(task, 'Turn limit reached (40); review and finish this task.'); return; }
        task.busy = true; const epoch = task.epoch;
        const message = { role: 'user', content: `Participant ${chat.senderUserId}: ${text}` };
        try {
            const response = await this.driver.generateResponse({
                systemPrompt: `You are the AI GM for a bounded Fate's Edge side task. The human GM supplied only this context: ${task.brief}\nStay within that scope. Ask for rulings if needed. Do not invent dice results, execute commands, or change main-campaign state. Players can roll using their client and report results. Keep replies concise. All outcomes and stat changes are proposals for human GM review.`,
                messages: [...task.history.slice(-30), message]
            });
            if (task.epoch !== epoch || task.status !== 'active') return;
            task.history.push(message, { role: 'assistant', content: String(response).slice(0, 12000) });
            task.history = task.history.slice(-40); task.turns++; this.save();
            this.say(task, response);
            await this.report(task, `Turn ${task.turns}\n${message.content}\n${String(response).slice(0, 6000)}`);
        } finally { task.busy = false; }
    }
    async finish(task) {
        if (task.busy) throw new Error('Wait for the current response, or pause the task first.');
        task.busy = true; const epoch = task.epoch;
        try {
            const summary = await this.driver.generateResponse({ systemPrompt: `Summarize this delegated Fate's Edge task for its human GM. Brief: ${task.brief}\nSeparate established events, unresolved questions, and proposed character/stat changes. Do not invent outcomes. Nothing has been applied to the main campaign.`, messages: task.history.slice(-40) });
            if (task.epoch !== epoch || terminal.has(task.status)) return;
            task.summary = String(summary).slice(0, 12000); task.status = 'awaiting-review';
            this.say(task, 'Side task complete. Return to the original room; the human GM will review the outcome.');
            this.pause(task); await this.report(task, task.summary); await this.closeRoom(task);
        } finally { task.busy = false; }
    }
    async closeRoom(task) { try { await this.request({ action: 'close', taskId: task.id, delegationToken: task.token }); } catch { /* Retry cleanup on a later cancel if source is unavailable. */ } }
    disconnect() {
        this.supported = false;
        for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Original room disconnected.')); }
        this.pending.clear();
        for (const task of this.tasks.values()) if (task.socket) this.pause(task);
    }
}
module.exports = { DelegatedTasks, HELP };
