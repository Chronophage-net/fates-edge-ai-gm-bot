'use strict';
const adventure = require('./adventure-context');
class AdventureRecovery {
    constructor(context, { retryMs = 5000, schedule = setTimeout, cancel = clearTimeout } = {}) {
        this.context = context;
        Object.assign(this, { retryMs, schedule, cancel });
        this.attempts = 0;
        this.timer = null;
        this.inFlight = null;
        this.generation = 0;
    }
    get campaign() { return this.context.orchestrator?.campaign; }
    disconnect() {
        this.generation++;
        if (this.timer) this.cancel(this.timer);
        this.timer = null;
        this.attempts = 0;
        const campaign = this.campaign;
        if (campaign) {
            if (campaign.state?.adventureSnapshot) campaign.pendingAdventureSnapshot = campaign.state.adventureSnapshot;
            void campaign.withPersistenceLock(() => {
                if (campaign.state?.adventureSnapshot) campaign.pendingAdventureSnapshot = campaign.state.adventureSnapshot;
            });
        }
    }
    async handshake(roomId) {
        if (!this.campaign) return false;
        this.campaign.roomId = roomId;
        if (this.timer) this.cancel(this.timer);
        this.timer = null;
        this.attempts = 0;
        await this.campaign.persistenceQueue;
        return this.attempt({ automatic: true });
    }
    attempt({ force = false, automatic = false } = {}) {
        if (this.inFlight) return this.inFlight;
        const campaign = this.campaign;
        if (!campaign?.pendingAdventureSnapshot) return Promise.resolve(false);
        const generation = this.generation;
        this.inFlight = campaign.withPersistenceLock(async () => {
            const snapshot = campaign.pendingAdventureSnapshot;
            if (!snapshot || generation !== this.generation) return false;
            this.attempts++;
            if (snapshot.roomId !== campaign.roomId) {
                this.context.recoveryError = 'Snapshot room identity does not match this room.';
                return false;
            }
            const archived = (campaign.state?.adventureArchive || []).some(entry =>
                entry.moduleId ? entry.moduleId === snapshot.moduleId && entry.startedAt === snapshot.startedAt : entry.title === snapshot.module?.title);
            if (archived && !force) {
                this.context.recoveryError = 'This adventure is already archived. Review it before using recover --force.';
                return false;
            }
            const ok = await adventure.recoverAdventure(this.context, snapshot, { force });
            if (!ok || generation !== this.generation || campaign.pendingAdventureSnapshot !== snapshot) return false;
            campaign.pendingAdventureSnapshot = null;
            this.attempts = 0;
            const dir = campaign.state?.adventureDirector;
            if (dir) { dir.pendingSelection = null; dir.abandonVotes = []; }
            adventure.invalidate();
            this.context.logger?.info?.('♻️ Recovered adventure state from snapshot');
            return true;
        }).then(ok => {
            if (!ok) {
                this.context.logger?.warn?.(`[AdventureRecovery] ${this.context.recoveryError || 'Recovery did not complete; snapshot retained.'}`);
                if (automatic && this.attempts < 2 && generation === this.generation && campaign.pendingAdventureSnapshot) {
                    this.timer = this.schedule(() => { this.timer = null; void this.attempt({ automatic: true }); }, this.retryMs);
                    this.timer?.unref?.();
                }
            }
            return ok;
        }).finally(() => { this.inFlight = null; });
        return this.inFlight;
    }
}
module.exports = { AdventureRecovery };
