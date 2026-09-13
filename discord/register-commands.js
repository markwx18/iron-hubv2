/* Registers the /ironhub slash command in ONE server (guild commands update instantly; global
   ones can take an hour). Run once, and again whenever the command shape below changes:

     DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... node register-commands.js

   The bot token is only needed here, on your machine. The Worker never holds it. */
const { DISCORD_APP_ID, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID } = process.env;

const STRING = 3, INTEGER = 4, SUB = 1;
export const COMMAND = {
  name: 'ironhub',
  description: 'View Iron Hub data (read-only)',
  type: 1,
  // "0" hides the command from everyone but server admins by default. The Worker also refuses
  // anyone who is not DISCORD_OWNER_ID; this just keeps it out of other members' menus.
  default_member_permissions: '0',
  contexts: [0],
  options: [
    { type: SUB, name: 'status', description: 'Readiness, streak, and what is scheduled next' },
    { type: SUB, name: 'chart', description: 'e1RM trend chart for a lift', options: [
      { type: STRING, name: 'exercise', description: 'Lift', required: true, autocomplete: true }] },
    { type: SUB, name: 'week', description: 'Weekly volume by muscle group' },
    { type: SUB, name: 'proposals', description: 'Pending agent proposals (approve in the app)' },
    { type: SUB, name: 'pr', description: 'Recent PR history', options: [
      { type: INTEGER, name: 'count', description: 'How many (default 10)', min_value: 1, max_value: 25 }] },
    { type: SUB, name: 'log', description: 'Recent full reasoning from an agent', options: [
      { type: STRING, name: 'agent', description: 'Which agent', required: true, choices: [
        { name: 'ZULU', value: 'zulu' }, { name: 'CHARLIE', value: 'charlie' }, { name: 'DELTA', value: 'delta' }, { name: 'ECHO', value: 'echo' }] },
      { type: INTEGER, name: 'count', description: 'How many entries (default 5)', min_value: 1, max_value: 20 }] },
    { type: SUB, name: 'compare', description: 'A past session vs the most recent matching one', options: [
      { type: STRING, name: 'session', description: 'Start typing a date (2026-06) or day (D2)', required: true, autocomplete: true },
      { type: STRING, name: 'scope', description: 'Whole session or one exercise', required: true, choices: [
        { name: 'Whole session', value: 'session' }, { name: 'One exercise', value: 'exercise' }] },
      { type: STRING, name: 'exercise', description: 'Needed for "One exercise"', autocomplete: true }] },
  ],
};

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  if (!DISCORD_APP_ID || !DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) {
    console.error('Set DISCORD_APP_ID, DISCORD_BOT_TOKEN and DISCORD_GUILD_ID first.');
    process.exit(1);
  }
  const res = await fetch('https://discord.com/api/v10/applications/' + DISCORD_APP_ID + '/guilds/' + DISCORD_GUILD_ID + '/commands', {
    method: 'PUT',
    headers: { Authorization: 'Bot ' + DISCORD_BOT_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify([COMMAND]),
  });
  const text = await res.text();
  if (!res.ok) { console.error('Failed (' + res.status + '): ' + text); process.exit(1); }
  console.log('Registered /ironhub in guild ' + DISCORD_GUILD_ID + '.');
}
