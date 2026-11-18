import {
  ActionRowBuilder, ApplicationCommandOptionType, ApplicationCommandType, AttachmentBuilder, ButtonBuilder, ButtonStyle,
  Client, GatewayIntentBits, GuildMember, MessageFlags,
  type ApplicationCommandDataResolvable, type AutocompleteInteraction, type ButtonInteraction, type ChatInputCommandInteraction,
  type Interaction, type InteractionEditReplyOptions,
} from 'discord.js';
import {
  createAudioPlayer, createAudioResource, entersState, joinVoiceChannel, StreamType, VoiceConnectionStatus,
  type AudioPlayer, type VoiceConnection,
} from '@discordjs/voice';
import { Readable } from 'node:stream';
import { cutClip, dailyTrack, getTrack, isPlaylistLink, loadPool, POOLS, randomTrack, Round, searchTracks, STAGES, today, type Mark, type Track } from './game.ts';
import { addScore, dailyStreak, getDailyMarks, leaderboard, saveDailyMarks, type Player } from './store.ts';

type ChannelGame = { round: Round; scope: string; pool: string; voice?: { connection: VoiceConnection; player: AudioPlayer } };
// ponytail: channel rounds live in memory and are lost on restart; daily progress and scores are in SQLite.
const games = new Map<string, ChannelGame>();

const MARK_TEXT: Record<Mark, string> = { skip: 'skipped', wrong: '🟥 wrong', artist: '🟨 right artist, wrong song', correct: '🟩 correct!' };

const songOption = (required: boolean) => ({
  name: 'song', description: 'Start typing the song title', type: ApplicationCommandOptionType.String, required, autocomplete: true,
});

const commands = [
  {
    name: 'play', description: 'Start a song guessing round in this channel',
    options: [
      { name: 'genre', description: 'Song pool', type: ApplicationCommandOptionType.String, choices: Object.entries(POOLS).map(([value, pool]) => ({ name: pool.label, value })) },
      { name: 'voice', description: 'Play the clips in your voice channel', type: ApplicationCommandOptionType.Boolean },
      { name: 'playlist', description: 'Spotify, YouTube or Deezer playlist link to pick songs from', type: ApplicationCommandOptionType.String },
    ],
  },
  { name: 'guess', description: 'Guess the song of the current round', options: [songOption(true)] },
  { name: 'daily', description: "Today's song: the same one for everyone in this server", options: [songOption(false)] },
  { name: 'leaderboard', description: 'Top song guessers in this server' },
];

function playerOf(interaction: Interaction): Player {
  const member = interaction.member instanceof GuildMember ? interaction.member : null;
  return { id: interaction.user.id, name: member?.displayName ?? interaction.user.displayName };
}

const describe = (track: Track) => `**${track.title}** by ${track.artist}`;

function button(customId: string, label: string, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
}

async function resolveGuess(value: string): Promise<Track | null> {
  // Autocomplete sends a Deezer id; if the user typed free text without picking, take the top search hit.
  if (/^\d+$/.test(value)) return getTrack(Number(value));
  return (await searchTracks(value))[0] ?? null;
}

async function channelMessage(channelId: string, game: ChannelGame, note = ''): Promise<InteractionEditReplyOptions> {
  const { round } = game;
  const header = `${note}${note ? '\n' : ''}🎵 **Song guess** · ${(await loadPool(game.pool)).label}\n${round.grid()}`;
  const attempt = round.marks.length;
  if (round.over) {
    const outcome = round.won ? `Got it for ${round.points} point${round.points === 1 ? '' : 's'}.` : 'Nobody got it.';
    const buttons = [button(`next:${channelId}`, 'Next song', ButtonStyle.Primary)];
    if (game.voice) buttons.push(button(`leave:${channelId}`, 'Leave voice'));
    return {
      content: `${header}\n${outcome} It was ${describe(round.track)}.`,
      files: [new AttachmentBuilder(await cutClip(round.track.id, 30, 'mp3'), { name: 'answer.mp3' })],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)],
    };
  }
  const buttons = [button(`skip:${channelId}:${attempt}`, attempt === STAGES.length - 1 ? 'Give up' : `Skip (+${STAGES[attempt + 1] - round.seconds}s)`)];
  if (game.voice) buttons.unshift(button(`replay:${channelId}`, 'Replay', ButtonStyle.Primary));
  return {
    content: `${header}\nClip: **${round.seconds}s** · attempt ${attempt + 1}/${STAGES.length} · guess with \`/guess\``,
    files: game.voice ? [] : [new AttachmentBuilder(await cutClip(round.track.id, round.seconds, 'mp3'), { name: 'clip.mp3' })],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)],
  };
}

async function playInVoice(game: ChannelGame) {
  if (!game.voice) return;
  const seconds = game.round.over ? 30 : game.round.seconds;
  const clip = await cutClip(game.round.track.id, seconds, 'ogg');
  game.voice.player.play(createAudioResource(Readable.from(clip), { inputType: StreamType.OggOpus }));
}

async function startRound(channelId: string, scope: string, pool: string, voice: ChannelGame['voice']): Promise<ChannelGame> {
  const game = { round: new Round(await randomTrack(pool)), scope, pool, voice };
  games.set(channelId, game);
  await playInVoice(game);
  return game;
}

async function applyChannelGuess(channelId: string, game: ChannelGame, player: Player, guess: Track | null) {
  const mark = game.round.guess(guess);
  if (game.round.won) addScore(game.scope, player, game.round.points);
  await playInVoice(game);
  const what = guess ? `guessed ${describe(guess)}: ${MARK_TEXT[mark]}` : 'skipped';
  return channelMessage(channelId, game, `**${player.name}** ${what}`);
}

async function onPlay(interaction: ChatInputCommandInteraction) {
  const existing = games.get(interaction.channelId);
  if (existing && !existing.round.over) {
    return interaction.reply({ content: 'A round is already running here. Guess with `/guess` or skip it.', flags: MessageFlags.Ephemeral });
  }
  const playlist = interaction.options.getString('playlist')?.trim();
  if (playlist && !isPlaylistLink(playlist)) {
    return interaction.reply({ content: 'That link isn\'t a Spotify, YouTube or Deezer playlist.', flags: MessageFlags.Ephemeral });
  }
  const pool = playlist ?? interaction.options.getString('genre') ?? existing?.pool ?? 'all';
  let voice = existing?.voice;
  if (interaction.options.getBoolean('voice') && !voice) {
    const channel = interaction.member instanceof GuildMember ? interaction.member.voice.channel : null;
    if (!channel) return interaction.reply({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply();
    const connection = joinVoiceChannel({ channelId: channel.id, guildId: channel.guild.id, adapterCreator: channel.guild.voiceAdapterCreator });
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    const player = createAudioPlayer();
    connection.subscribe(player);
    voice = { connection, player };
  } else {
    await interaction.deferReply();
  }
  try {
    await loadPool(pool);
  } catch (error) {
    console.error(error);
    return interaction.editReply(`Couldn't load that playlist: ${(error as Error).message}`);
  }
  const game = await startRound(interaction.channelId, dailyScope(interaction), pool, voice);
  await interaction.editReply(await channelMessage(interaction.channelId, game));
}

async function onGuess(interaction: ChatInputCommandInteraction) {
  const game = games.get(interaction.channelId);
  if (!game || game.round.over) return interaction.reply({ content: 'No round running here. Start one with `/play`.', flags: MessageFlags.Ephemeral });
  await interaction.deferReply();
  const guess = await resolveGuess(interaction.options.getString('song', true));
  if (!guess) return interaction.editReply('No song found for that, try picking one from the list.');
  // Another guess may have ended the round while Deezer was answering.
  if (game.round.over) return interaction.editReply('Too late, the round is over.');
  await interaction.editReply(await applyChannelGuess(interaction.channelId, game, playerOf(interaction), guess));
}

function dailyScope(interaction: Interaction) {
  return interaction.guildId ?? `user:${interaction.user.id}`;
}

async function dailyMessage(scope: string, round: Round, player: Player): Promise<InteractionEditReplyOptions> {
  const day = today();
  if (round.over) {
    const streak = dailyStreak(scope, player.id, day);
    return {
      content: `${round.grid()} ${round.won ? `${round.marks.length}/${STAGES.length}` : 'X'}${streak > 1 ? ` · 🔥 ${streak} day streak` : ''}\nToday's song was ${describe(round.track)}. New song tomorrow.`,
      files: [new AttachmentBuilder(await cutClip(round.track.id, 30, 'mp3'), { name: 'answer.mp3' })],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button('dshare', 'Share result', ButtonStyle.Primary))],
    };
  }
  const attempt = round.marks.length;
  return {
    content: `📅 **Daily song** ${day}\n${round.grid()}\nClip: **${round.seconds}s** · attempt ${attempt + 1}/${STAGES.length} · answer with \`/daily song:\``,
    files: [new AttachmentBuilder(await cutClip(round.track.id, round.seconds, 'mp3'), { name: 'clip.mp3' })],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button(`dskip:${attempt}`, attempt === STAGES.length - 1 ? 'Give up' : 'Skip'))],
  };
}

async function loadDaily(interaction: Interaction) {
  const scope = dailyScope(interaction);
  const day = today();
  const player = playerOf(interaction);
  return { scope, day, player, round: new Round(await dailyTrack(scope, day), getDailyMarks(scope, day, player.id)) };
}

async function onDaily(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { scope, day, player, round } = await loadDaily(interaction);
  const value = interaction.options.getString('song');
  let note = '';
  if (value && !round.over) {
    const guess = await resolveGuess(value);
    if (!guess) return interaction.editReply('No song found for that, try picking one from the list.');
    note = `You guessed ${describe(guess)}: ${MARK_TEXT[round.guess(guess)]}\n`;
    saveDailyMarks(scope, day, player, round.marks);
  }
  const message = await dailyMessage(scope, round, player);
  await interaction.editReply({ ...message, content: note + message.content });
}

async function onButton(interaction: ButtonInteraction) {
  const [action, channelId, attempt] = interaction.customId.split(':');

  if (action === 'dskip' || action === 'dshare') {
    const { scope, day, player, round } = await loadDaily(interaction);
    if (action === 'dshare') {
      if (!round.over) return interaction.reply({ content: 'Finish the daily first.', flags: MessageFlags.Ephemeral });
      return interaction.reply(`📅 **${player.name}**'s daily song ${day}: ${round.grid()} ${round.won ? `${round.marks.length}/${STAGES.length}` : 'X'}`);
    }
    if (!round.over && String(round.marks.length) === channelId) {
      round.guess(null);
      saveDailyMarks(scope, day, player, round.marks);
    }
    await interaction.deferUpdate();
    const message = await dailyMessage(scope, round, player);
    return interaction.editReply({ ...message, attachments: [] });
  }

  const game = games.get(channelId);
  if (!game) return interaction.reply({ content: 'That round is gone. Start a new one with `/play`.', flags: MessageFlags.Ephemeral });

  if (action === 'skip') {
    // Ignore clicks on old messages so a stale button can't skip the current clip.
    if (game.round.over || String(game.round.marks.length) !== attempt) return interaction.deferUpdate();
    await interaction.deferReply();
    return interaction.editReply(await applyChannelGuess(channelId, game, playerOf(interaction), null));
  }
  if (action === 'replay') {
    await interaction.deferUpdate();
    return playInVoice(game);
  }
  if (action === 'next') {
    if (!game.round.over) return interaction.deferUpdate();
    await interaction.deferReply();
    const next = await startRound(channelId, game.scope, game.pool, game.voice);
    return interaction.editReply(await channelMessage(channelId, next));
  }
  if (action === 'leave') {
    game.voice?.connection.destroy();
    games.delete(channelId);
    return interaction.reply('Left the voice channel. 👋');
  }
  throw new Error(`Unknown button ${interaction.customId}`);
}

async function onAutocomplete(interaction: AutocompleteInteraction) {
  // ponytail: one Deezer search per keystroke; add a small cache if Deezer starts rate limiting (50 req / 5 s).
  const tracks = await searchTracks(interaction.options.getFocused());
  await interaction.respond(tracks.map((track) => ({ name: `${track.title} — ${track.artist}`.slice(0, 100), value: String(track.id) })));
}

export async function startBot(token: string) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

  client.once('clientReady', async () => {
    // Overwriting commands must keep the Activity's "Launch" entry point command, or Discord rejects it.
    const existing = await client.application!.commands.fetch();
    const entryPoint = existing.find((command) => command.type === ApplicationCommandType.PrimaryEntryPoint);
    const all: ApplicationCommandDataResolvable[] = [...commands as ApplicationCommandDataResolvable[]];
    if (entryPoint) all.push(entryPoint.toJSON() as ApplicationCommandDataResolvable);
    await client.application!.commands.set(all);
    console.log(`Bot ready as ${client.user!.tag}`);
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isAutocomplete()) return await onAutocomplete(interaction);
      if (interaction.isButton()) return await onButton(interaction);
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName === 'play') return await onPlay(interaction);
      if (interaction.commandName === 'guess') return await onGuess(interaction);
      if (interaction.commandName === 'daily') return await onDaily(interaction);
      if (interaction.commandName === 'leaderboard') {
        const rows = leaderboard(dailyScope(interaction));
        const lines = rows.map((row, index) => `${index + 1}. **${row.name}**: ${row.points} pts (${row.wins} songs)`);
        return await interaction.reply(lines.length ? `🏆 **Song guess leaderboard**\n${lines.join('\n')}` : 'No points yet. Start with `/play`.');
      }
    } catch (error) {
      console.error(error);
      if (!interaction.isRepliable()) return;
      const reply = { content: 'Something went wrong, try again.', flags: MessageFlags.Ephemeral } as const;
      if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
      else await interaction.reply(reply);
    }
  });

  await client.login(token);
  return client;
}
