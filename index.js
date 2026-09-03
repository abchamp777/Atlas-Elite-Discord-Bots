require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
} = require("discord.js");

const { Pool } = require("pg");

// ============================================================
// CONFIG
// ============================================================

const {
  WELCOME_BOT_TOKEN,
  TRACKER_BOT_TOKEN,
  WELCOME_BOT_CLIENT_ID,
  TRACKER_BOT_CLIENT_ID,
  GUILD_ID,
  STAFF_ROLE_ID,
  WELCOME_CHANNEL_ID,
  STATS_CHANNEL_ID,
  DATABASE_URL,
} = process.env;

if (!WELCOME_BOT_TOKEN) {
  console.error("❌ WELCOME_BOT_TOKEN is missing from .env");
  process.exit(1);
}

if (!TRACKER_BOT_TOKEN) {
  console.error("❌ TRACKER_BOT_TOKEN is missing from .env");
  process.exit(1);
}

if (!WELCOME_BOT_CLIENT_ID) {
  console.error("❌ WELCOME_BOT_CLIENT_ID is missing from .env");
  process.exit(1);
}

if (!TRACKER_BOT_CLIENT_ID) {
  console.error("❌ TRACKER_BOT_CLIENT_ID is missing from .env");
  process.exit(1);
}

if (!GUILD_ID) {
  console.error("❌ GUILD_ID is missing from .env");
  process.exit(1);
}

if (!STAFF_ROLE_ID) {
  console.error("❌ STAFF_ROLE_ID is missing from .env");
  process.exit(1);
}

if (!WELCOME_CHANNEL_ID) {
  console.error("❌ WELCOME_CHANNEL_ID is missing from .env");
  process.exit(1);
}

if (!STATS_CHANNEL_ID) {
  console.error("❌ STATS_CHANNEL_ID is missing from .env");
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL is missing from .env");
  process.exit(1);
}

// ============================================================
// DATABASE (NEON CONFIG)
// ============================================================

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

async function setupDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_stats (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      flights INTEGER NOT NULL DEFAULT 0,
      miles NUMERIC NOT NULL DEFAULT 0,
      rank TEXT NOT NULL DEFAULT 'Bronze',
      manual_rank BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS flight_records (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      base_miles NUMERIC NOT NULL,
      awarded_miles NUMERIC NOT NULL,
      multiplier NUMERIC NOT NULL,
      added_by TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("✅ Database tables ready.");
}

// ============================================================
// RANK SYSTEM
// ============================================================

const RANKS = {
  Bronze: { minimum: 0, multiplier: 1 },
  Silver: { minimum: 2000, multiplier: 1.1 },
  Gold: { minimum: 7500, multiplier: 1.25 },
  Emerald: { minimum: 12000, multiplier: 1.5 },
  Diamond: { minimum: 20000, multiplier: 2 },
  Platinum: { minimum: Infinity, multiplier: 2 },
};

function getAutomaticRank(miles) {
  miles = Number(miles);
  if (miles >= 20000) return "Diamond";
  if (miles >= 12000) return "Emerald";
  if (miles >= 7500) return "Gold";
  if (miles >= 2000) return "Silver";
  return "Bronze";
}

function getMultiplier(rank) {
  return RANKS[rank]?.multiplier ?? 1;
}

function getNextRank(rank, miles) {
  if (rank === "Platinum") {
    return { name: "Platinum", remaining: 0 };
  }
  if (miles < 2000) return { name: "Silver", remaining: 2000 - miles };
  if (miles < 7500) return { name: "Gold", remaining: 7500 - miles };
  if (miles < 12000) return { name: "Emerald", remaining: 12000 - miles };
  if (miles < 20000) return { name: "Diamond", remaining: 20000 - miles };
  return { name: "Diamond", remaining: 0 };
}

// ============================================================
// DATABASE HELPERS
// ============================================================

async function ensureMember(user) {
  const result = await pool.query(
    `
    INSERT INTO member_stats
      (user_id, username)
    VALUES
      ($1, $2)
    ON CONFLICT (user_id)
    DO UPDATE SET
      username = EXCLUDED.username,
      updated_at = CURRENT_TIMESTAMP
    RETURNING *;
    `,
    [user.id, user.username]
  );
  return result.rows[0];
}

async function getMember(userId) {
  const result = await pool.query(
    `SELECT * FROM member_stats WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0];
}

async function updateRankAutomatically(userId) {
  const member = await getMember(userId);
  if (!member) return null;
  if (member.manual_rank) return member.rank;

  const newRank = getAutomaticRank(member.miles);
  await pool.query(
    `
    UPDATE member_stats
    SET rank = $1, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = $2
    `,
    [newRank, userId]
  );
  return newRank;
}

// ============================================================
// STAFF & CHANNEL CHECKS
// ============================================================

function isStaff(interaction) {
  return interaction.member?.roles?.cache?.has(STAFF_ROLE_ID);
}

function isStatsChannel(interaction) {
  return interaction.channelId === STATS_CHANNEL_ID;
}

// ============================================================
// WELCOME BOT
// ============================================================

const welcomeBot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

welcomeBot.once("ready", () => {
  console.log(`👋 Welcome Bot online as ${welcomeBot.user.tag}`);
});

welcomeBot.on("guildMemberAdd", async (member) => {
  try {
    const channel = await member.guild.channels.fetch(WELCOME_CHANNEL_ID);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setTitle("✈️ Welcome to Atlas Elite Flight Services")
      .setDescription(
        `Hey ${member}! Welcome to **Atlas Elite Flight Services**.\n\n` +
        `Feel free to check out the channels and visit our website to schedule a flight with us.\n\n` +
        `🌐 https://atlas-elite-flight-services.vercel.app/`
      )
      .setThumbnail(member.user.displayAvatarURL())
      .setFooter({ text: "Atlas Elite Flight Services" })
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error("❌ Welcome error:", error);
  }
});

// ============================================================
// TRACKER BOT & SLASH COMMANDS
// ============================================================

const trackerBot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

const commands = [
  new SlashCommandBuilder()
    .setName("profile")
    .setDescription("View an Atlas Elite traveler profile.")
    .addUserOption((option) =>
      option.setName("user").setDescription("Traveler to view.").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("View the Atlas Elite mileage leaderboard."),

  new SlashCommandBuilder()
    .setName("flight")
    .setDescription("Atlas Elite staff flight controls.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Add one completed flight and manually entered miles.")
        .addUserOption((option) => option.setName("user").setDescription("Traveler.").setRequired(true))
        .addIntegerOption((option) => option.setName("miles").setDescription("Base miles.").setRequired(true).setMinValue(1))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Remove miles and one flight.")
        .addUserOption((option) => option.setName("user").setDescription("Traveler.").setRequired(true))
        .addIntegerOption((option) => option.setName("miles").setDescription("Miles to remove.").setRequired(true).setMinValue(0))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("set")
        .setDescription("Set a traveler's exact flights and miles.")
        .addUserOption((option) => option.setName("user").setDescription("Traveler.").setRequired(true))
        .addIntegerOption((option) => option.setName("flights").setDescription("Exact flight count.").setRequired(true).setMinValue(0))
        .addIntegerOption((option) => option.setName("miles").setDescription("Exact total miles.").setRequired(true).setMinValue(0))
    ),

  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("Atlas Elite staff rank controls.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("set")
        .setDescription("Manually set a traveler's rank.")
        .addUserOption((option) => option.setName("user").setDescription("Traveler.").setRequired(true))
        .addStringOption((option) =>
          option
            .setName("rank")
            .setDescription("Rank to assign.")
            .setRequired(true)
            .addChoices(
              { name: "Bronze", value: "Bronze" },
              { name: "Silver", value: "Silver" },
              { name: "Gold", value: "Gold" },
              { name: "Emerald", value: "Emerald" },
              { name: "Diamond", value: "Diamond" },
              { name: "Platinum", value: "Platinum" }
            )
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("auto")
        .setDescription("Return a traveler to automatic rank progression.")
        .addUserOption((option) => option.setName("user").setDescription("Traveler.").setRequired(true))
    ),
];

async function registerCommands() {
  const guild = await trackerBot.guilds.fetch(GUILD_ID);
  await guild.commands.set(commands.map((command) => command.toJSON()));
  console.log("✅ Slash commands registered.");
}

trackerBot.once("ready", async () => {
  console.log(`📊 Tracker Bot online as ${trackerBot.user.tag}`);
  try {
    await registerCommands();
    const guild = await trackerBot.guilds.fetch(GUILD_ID);
    await guild.members.fetch();
    for (const member of guild.members.cache.values()) {
      if (member.user.bot) continue;
      await ensureMember(member.user);
    }
    console.log("✅ Existing server members checked.");
  } catch (error) {
    console.error("❌ Tracker startup error:", error);
  }
});

trackerBot.on("guildMemberAdd", async (member) => {
  try {
    if (member.user.bot) return;
    await ensureMember(member.user);
  } catch (error) {
    console.error("❌ Member profile creation error:", error);
  }
});

trackerBot.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    // PROFILE
    if (interaction.commandName === "profile") {
      if (!isStatsChannel(interaction)) {
        return interaction.reply({
          content: `❌ Use this command in <#${STATS_CHANNEL_ID}>.`,
          ephemeral: true,
        });
      }

      const target = interaction.options.getUser("user") || interaction.user;
      await ensureMember(target);
      const member = await getMember(target.id);

      const miles = Number(member.miles);
      const flights = Number(member.flights);
      const rank = member.rank;
      const multiplier = getMultiplier(rank);
      const next = getNextRank(rank, miles);

      const nextText =
        rank === "Platinum"
          ? "⭐ Manual Platinum rank"
          : `${next.name} • ${next.remaining.toLocaleString()} miles remaining`;

      const embed = new EmbedBuilder()
        .setTitle(`✈️ ${target.username}'s Atlas Elite Profile`)
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name: "🏅 Rank", value: rank, inline: true },
          { name: "✈️ Flights", value: flights.toLocaleString(), inline: true },
          { name: "🛫 Total Miles", value: miles.toLocaleString(), inline: true },
          { name: "⚡ Multiplier", value: `${multiplier}×`, inline: true },
          { name: "🎯 Next Rank", value: nextText, inline: true }
        )
        .setFooter({ text: "Atlas Elite Flight Services" })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    // LEADERBOARD
    if (interaction.commandName === "leaderboard") {
      if (!isStatsChannel(interaction)) {
        return interaction.reply({
          content: `❌ Use this command in <#${STATS_CHANNEL_ID}>.`,
          ephemeral: true,
        });
      }

      const result = await pool.query(`
        SELECT * FROM member_stats ORDER BY miles DESC LIMIT 10
      `);

      if (result.rows.length === 0) {
        return interaction.reply({
          content: "There are no traveler profiles yet.",
          ephemeral: true,
        });
      }

      let description = "";
      for (let i = 0; i < result.rows.length; i++) {
        const member = result.rows[i];
        let medal;
        if (i === 0) medal = "🥇";
        else if (i === 1) medal = "🥈";
        else if (i === 2) medal = "🥉";
        else medal = `**${i + 1}.**`;

        description +=
          `${medal} **${member.username}**\n` +
          `> ${Number(member.miles).toLocaleString()} miles • ` +
          `${member.flights} flights • ${member.rank}\n\n`;
      }

      const embed = new EmbedBuilder()
        .setTitle("🏆 Atlas Elite Traveler Leaderboard")
        .setDescription(description)
        .setFooter({ text: "Top 10 travelers by total miles" })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    // STAFF CHECKS
    if (
      interaction.commandName === "flight" ||
      interaction.commandName === "rank"
    ) {
      if (!isStaff(interaction)) {
        return interaction.reply({
          content: "❌ You need the **Atlas Elite Staff** role to use this command.",
          ephemeral: true,
        });
      }
    }

    // FLIGHT ADD
    if (
      interaction.commandName === "flight" &&
      interaction.options.getSubcommand() === "add"
    ) {
      const target = interaction.options.getUser("user");
      const baseMiles = interaction.options.getInteger("miles");

      await ensureMember(target);
      const member = await getMember(target.id);

      const multiplier = getMultiplier(member.rank);
      const awardedMiles = Math.round(baseMiles * multiplier);
      const newFlights = Number(member.flights) + 1;
      const newMiles = Number(member.miles) + awardedMiles;

      await pool.query(
        `
        UPDATE member_stats
        SET flights = $1, miles = $2, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $3
        `,
        [newFlights, newMiles, target.id]
      );

      await pool.query(
        `
        INSERT INTO flight_records (user_id, base_miles, awarded_miles, multiplier, added_by)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [target.id, baseMiles, awardedMiles, multiplier, interaction.user.id]
      );

      const newRank = await updateRankAutomatically(target.id);

      const embed = new EmbedBuilder()
        .setTitle("✈️ Flight Added")
        .setDescription(`Successfully recorded a completed flight for **${target.username}**.`)
        .addFields(
          { name: "Base Miles", value: `${baseMiles.toLocaleString()}`, inline: true },
          { name: "Multiplier", value: `${multiplier}×`, inline: true },
          { name: "Miles Awarded", value: `${awardedMiles.toLocaleString()}`, inline: true },
          { name: "Total Miles", value: `${newMiles.toLocaleString()}`, inline: true },
          { name: "Flights", value: `${newFlights}`, inline: true },
          { name: "Rank", value: newRank, inline: true }
        )
        .setThumbnail(target.displayAvatarURL())
        .setFooter({ text: `Recorded by ${interaction.user.username}` })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    // FLIGHT REMOVE
    if (
      interaction.commandName === "flight" &&
      interaction.options.getSubcommand() === "remove"
    ) {
      const target = interaction.options.getUser("user");
      const milesToRemove = interaction.options.getInteger("miles");

      await ensureMember(target);
      const member = await getMember(target.id);

      const newFlights = Math.max(0, Number(member.flights) - 1);
      const newMiles = Math.max(0, Number(member.miles) - milesToRemove);

      await pool.query(
        `
        UPDATE member_stats
        SET flights = $1, miles = $2, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $3
        `,
        [newFlights, newMiles, target.id]
      );

      const newRank = await updateRankAutomatically(target.id);

      return interaction.reply({
        content:
          `✅ Removed **${milesToRemove.toLocaleString()} miles** and **1 flight** from **${target.username}**.\n\n` +
          `✈️ Flights: ${newFlights}\n` +
          `🛫 Miles: ${newMiles.toLocaleString()}\n` +
          `🏅 Rank: ${newRank}`,
      });
    }

    // FLIGHT SET
    if (
      interaction.commandName === "flight" &&
      interaction.options.getSubcommand() === "set"
    ) {
      const target = interaction.options.getUser("user");
      const flights = interaction.options.getInteger("flights");
      const miles = interaction.options.getInteger("miles");

      await ensureMember(target);
      await pool.query(
        `
        UPDATE member_stats
        SET flights = $1, miles = $2, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $3
        `,
        [flights, miles, target.id]
      );

      const newRank = await updateRankAutomatically(target.id);

      return interaction.reply({
        content:
          `✅ Updated **${target.username}**.\n\n` +
          `✈️ Flights: ${flights.toLocaleString()}\n` +
          `🛫 Miles: ${miles.toLocaleString()}\n` +
          `🏅 Rank: ${newRank}`,
      });
    }

    // RANK SET
    if (
      interaction.commandName === "rank" &&
      interaction.options.getSubcommand() === "set"
    ) {
      const target = interaction.options.getUser("user");
      const rank = interaction.options.getString("rank");

      await ensureMember(target);
      await pool.query(
        `
        UPDATE member_stats
        SET rank = $1, manual_rank = TRUE, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $2
        `,
        [rank, target.id]
      );

      return interaction.reply({
        content:
          `✅ **${target.username}** is now manually set to **${rank}**.\n\n` +
          `This rank will NOT be automatically changed until you use:\n` +
          `\`/rank auto\``,
      });
    }

    // RANK AUTO
    if (
      interaction.commandName === "rank" &&
      interaction.options.getSubcommand() === "auto"
    ) {
      const target = interaction.options.getUser("user");

      await ensureMember(target);
      await pool.query(
        `
        UPDATE member_stats
        SET manual_rank = FALSE, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $1
        `,
        [target.id]
      );

      const newRank = await updateRankAutomatically(target.id);

      return interaction.reply({
        content:
          `✅ Automatic ranking restored for **${target.username}**.\n\n` +
          `Current automatic rank: **${newRank}**`,
      });
    }
  } catch (error) {
    console.error("❌ Interaction error:", error);
    const replyPayload = {
      content: "❌ Something went wrong while processing that command.",
      ephemeral: true,
    };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(replyPayload);
    } else {
      await interaction.reply(replyPayload);
    }
  }
});

// ============================================================
// START EVERYTHING
// ============================================================

async function start() {
  try {
    console.log("🚀 Starting Atlas Elite Flight Services bots...");
    const dbTest = await pool.query("SELECT NOW()");
    console.log(`🗄️ Database connected: ${dbTest.rows[0].now}`);

    await setupDatabase();

    await welcomeBot.login(WELCOME_BOT_TOKEN);
    await trackerBot.login(TRACKER_BOT_TOKEN);

    console.log("========================================");
    console.log("✈️ ATLAS ELITE SYSTEM ONLINE");
    console.log("========================================");
  } catch (error) {
    console.error("❌ Failed to start:", error);
    process.exit(1);
  }
}

start();