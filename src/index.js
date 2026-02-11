const { Client, GatewayIntentBits, PermissionsBitField, ChannelType, REST, Routes, SlashCommandBuilder } = require('discord.js');
const chalk = require('chalk');
require('dotenv').config();

const requiredEnv = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID'];
const missing = requiredEnv.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(chalk.red(`Missing environment variables: ${missing.join(', ')}`));
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const cloneCommand = new SlashCommandBuilder()
  .setName('clone-server')
  .setDescription('Copies a source server structure into the current server with strict permission checks')
  .addStringOption((option) =>
    option
      .setName('source_guild_id')
      .setDescription('Source server ID')
      .setRequired(true),
  )
  .addBooleanOption((option) =>
    option
      .setName('delete_existing')
      .setDescription('Delete destination channels/roles (excluding @everyone) before cloning')
      .setRequired(false),
  );

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), {
    body: [cloneCommand.toJSON()],
  });
  console.log(chalk.green('Slash commands registered successfully.'));
}

function assertAuthorization(interaction, sourceGuild, destinationGuild) {
  const actor = interaction.member;
  const hasAdmin = actor.permissions.has(PermissionsBitField.Flags.Administrator);

  if (!hasAdmin) {
    throw new Error('You must be an Administrator in the destination server.');
  }

  const meInSource = sourceGuild.members.me;
  const meInDestination = destinationGuild.members.me;

  if (!meInSource?.permissions.has(PermissionsBitField.Flags.ViewAuditLog)) {
    throw new Error('Bot must have permission to read source data (ViewAuditLog minimum check failed).');
  }

  if (!meInDestination?.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    throw new Error('Bot needs ManageGuild permission in the destination server.');
  }
}

function buildRoleMap(sourceGuild) {
  return sourceGuild.roles.cache
    .filter((role) => role.name !== '@everyone' && !role.managed)
    .sort((a, b) => a.position - b.position)
    .map((role) => ({
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      permissions: role.permissions.bitfield.toString(),
      position: role.position,
    }));
}

function buildChannelMap(sourceGuild) {
  return sourceGuild.channels.cache
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((channel) => ({
      name: channel.name,
      type: channel.type,
      parent: channel.parent?.name ?? null,
      topic: channel.topic ?? null,
      nsfw: channel.nsfw ?? false,
      rateLimitPerUser: channel.rateLimitPerUser ?? 0,
    }));
}

async function clearDestination(destinationGuild) {
  for (const [, channel] of destinationGuild.channels.cache) {
    await channel.delete('Preparing destination for authorized migration');
  }

  for (const [, role] of destinationGuild.roles.cache) {
    if (role.name !== '@everyone' && !role.managed) {
      await role.delete('Preparing destination for authorized migration');
    }
  }
}

async function cloneStructure(sourceGuild, destinationGuild, shouldDeleteExisting) {
  if (shouldDeleteExisting) {
    await clearDestination(destinationGuild);
  }

  const roleMap = buildRoleMap(sourceGuild);
  const createdRoles = new Map();

  for (const roleData of roleMap) {
    const createdRole = await destinationGuild.roles.create({
      name: roleData.name,
      color: roleData.color,
      hoist: roleData.hoist,
      mentionable: roleData.mentionable,
      permissions: BigInt(roleData.permissions),
      reason: 'Authorized structure migration',
    });
    createdRoles.set(roleData.name, createdRole);
  }

  const channelMap = buildChannelMap(sourceGuild);
  const createdCategories = new Map();

  for (const channelData of channelMap) {
    if (channelData.type === ChannelType.GuildCategory) {
      const category = await destinationGuild.channels.create({
        name: channelData.name,
        type: ChannelType.GuildCategory,
        reason: 'Authorized structure migration',
      });
      createdCategories.set(channelData.name, category.id);
      continue;
    }

    if (
      channelData.type === ChannelType.GuildText ||
      channelData.type === ChannelType.GuildVoice ||
      channelData.type === ChannelType.GuildAnnouncement
    ) {
      await destinationGuild.channels.create({
        name: channelData.name,
        type: channelData.type,
        parent: channelData.parent ? createdCategories.get(channelData.parent) : undefined,
        topic: channelData.topic,
        nsfw: channelData.nsfw,
        rateLimitPerUser: channelData.rateLimitPerUser,
        reason: 'Authorized structure migration',
      });
    }
  }
}

client.once('ready', async () => {
  console.log(chalk.cyan(`Logged in as ${client.user.tag}`));
  try {
    await registerCommands();
  } catch (error) {
    console.error(chalk.red(`Failed to register slash commands: ${error.message}`));
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'clone-server') {
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const sourceGuildId = interaction.options.getString('source_guild_id', true);
    const shouldDelete = interaction.options.getBoolean('delete_existing') ?? false;

    const sourceGuild = await client.guilds.fetch(sourceGuildId);
    const destinationGuild = interaction.guild;

    if (!destinationGuild) {
      throw new Error('This command can only be used inside a destination server.');
    }

    await sourceGuild.channels.fetch();
    await sourceGuild.roles.fetch();
    await destinationGuild.channels.fetch();
    await destinationGuild.roles.fetch();
    await sourceGuild.members.fetchMe();
    await destinationGuild.members.fetchMe();

    assertAuthorization(interaction, sourceGuild, destinationGuild);

    await cloneStructure(sourceGuild, destinationGuild, shouldDelete);

    await interaction.editReply(
      '✅ Authorized migration completed. Only server structure (roles/channels/categories) was copied.',
    );
  } catch (error) {
    await interaction.editReply(`❌ Migration failed: ${error.message}`);
  }
});

client.login(process.env.DISCORD_TOKEN);
