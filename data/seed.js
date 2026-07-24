/**
 * Seed data for wiki and talents
 */
export const SEED_WIKI = [
    { id: 1, title: 'The Ninth Taboo', category: 'lore', body: 'The wise stop at eight. The ninth is the Hollow\'s share.', tags: ['taboo', 'hollow'], source: 'local' },
    { id: 2, title: 'Aeler', category: 'regions', body: 'Mountain holds of the dwarves.', tags: ['dwarf', 'mountain'], source: 'local' },
    { id: 3, title: 'Boons', category: 'rules', body: 'Earn on Partial (1) or Miss (2). Spend to re-roll, improve Position, activate Assets. Max 5. Trim to 2 at scene end.', tags: ['mechanics'], source: 'local' },
    { id: 4, title: 'Longsword', category: 'equipment', body: 'A balanced medium melee weapon.', tags: ['weapon', 'medium'], cost: 8, source: 'local' },
    { id: 5, title: 'Leather Armor', category: 'equipment', body: 'Light flexible armor.', tags: ['armor', 'light'], cost: 4, source: 'local' },
    { id: 6, title: 'Workshop (Minor)', category: 'assets', body: 'A small workspace for crafting and repairs.', tags: ['craft'], cost: 4, source: 'local' }
];

export const SEED_TALENTS = [
    { id: 1, name: 'Weapon Mastery (longsword)', cost: 5, description: '+1 die when using a longsword.' },
    { id: 2, name: 'Silver Tongue', cost: 2, description: 'Reroll one die when using Sway.' },
    { id: 3, name: 'Keen Senses', cost: 2, description: '+1 die to perception rolls.' }
];
